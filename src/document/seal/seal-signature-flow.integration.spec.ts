import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import axios from 'axios';

import { DocumentService } from '../document.service';
import { DocumentEntity } from '../entities/document.entity';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { UserService } from 'src/user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from '../verification-code.service';
import { DocumentTransactionService } from '../document-transaction.service';
import { EfirmaService } from 'src/efirma/efirma.service';
import { SummaryDocumentService } from '../summary-document/summary-document.service';
import { AdvancedSummaryDocumentService } from '../summary-document/advanced-summary-document.service';
import { SignatureQrService } from '../services/signature-qr.service';

import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { SealApiService } from './services/seal-api.service';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentDto } from './dto/seal-document.dto';
import { SealDocumentResponse } from './interfaces/seal-document-response.interface';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Integración del flujo "se terminó de firmar un documento con e.firma (FIEL)".
 *
 * A diferencia de los specs unitarios —donde cada pieza mockea a su vecina— acá se instancian las
 * clases REALES encadenadas: DocumentService → SealDocumentUseCase → SealApiService → SealMapper.
 * Solo se sustituyen los bordes del sistema: la base de datos (repositorios de TypeORM), la red
 * (axios) y la infraestructura que no participa del sellado (MinIO, Kafka, correo).
 *
 * `EfirmaService` también se sustituye porque firmar de verdad exigiría un .cer/.key reales del
 * SAT; lo que sí es real es TODO el camino que recorre su resultado desde que se guarda en el
 * colaborador hasta que sale por HTTP hacia Seal Service y vuelve convertido en una fila de
 * `document_seals`. Ese camino es justamente lo que ningún test unitario cubre completo.
 */
const SEAL_CONFIG: Record<string, string> = {
  SEAL_SERVICE_URL: 'http://seal-service:3000',
  SEAL_SERVICE_API_KEY: 'api-key-de-prueba',
};

const TEST_GEOLOCATION = {
  latitude: 19.4326,
  longitude: -99.1332,
  accuracy: 15,
};

const EFIRMA_INPUT = {
  password: 'clave-correcta',
  keyFile: {
    originalname: 'llave.key',
    size: 1024,
    buffer: Buffer.from('key'),
  } as Express.Multer.File,
  cerFile: {
    originalname: 'certificado.cer',
    size: 1024,
    buffer: Buffer.from('cer'),
  } as Express.Multer.File,
};

/**
 * Respuesta real de `POST /seal/signature` (ver `SealService.sealSigatures` en la rama
 * `development` de seal-service).
 */
const PROVIDER_RESPONSE: SealDocumentResponse = {
  documentId: 'doc-1',
  hashHex: 'f00dcafe',
  hashAlgorithm: 'sha256',
  hashVersion: 'v1',
  canonicalString: 'v1||13:hash-original|5:doc-1||...',
  sealedAt: '2026-08-13T19:00:00.000Z',
  timeStamp: {
    status: true,
    hashProcessed: 'f00dcafe',
    fileBase64: 'tsr-en-base64',
    uuid: 'ts-uuid',
  },
  nom151: {
    status: true,
    hashProcessed: 'f00dcafe',
    file: 'nom151-en-base64',
    uuid: 'nom-uuid',
    pdfFile: 'pdf-en-base64',
  },
};

function mockDocument(overrides: Partial<DocumentEntity> = {}): DocumentEntity {
  return {
    id: 'doc-1',
    fileName: 'contrato.pdf',
    objectKey: 'object-key-1',
    originalHash: 'hash-original',
    status: DOCUMENT_STATUS_ENUM.PENDING,
    isSequential: true,
    totalSigners: 1,
    completedSignersCount: 0,
    requiresVerification: false,
    createdBy: 'creator-1',
    ipAddress: '127.0.0.1',
    ...overrides,
  } as DocumentEntity;
}

function buildFielSigner(
  overrides: Partial<CollaboratorEntity> & { userId?: string } = {},
): CollaboratorEntity {
  const userId = overrides.userId ?? 'user-1';
  const { userId: _omit, ...entityOverrides } = overrides;
  return {
    id: overrides.id ?? 'collaborator-1',
    documentId: 'doc-1',
    accountId: `account-of-${userId}`,
    email: null,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: 0,
    ipAddress: '127.0.0.1',
    account: {
      id: `account-of-${userId}`,
      userId,
      user: {
        id: userId,
        firstName: 'Firmante',
        lastName: 'Uno',
        email: 'firmante@correo.com',
        signatureId: 'signature-1',
      },
    },
    ...entityOverrides,
  } as unknown as CollaboratorEntity;
}

/** Cuerpo del POST que salió hacia Seal Service, ya tipado (axios lo entrega como `unknown`). */
function sentPayload(callIndex = 0): SealDocumentDto {
  return mockedAxios.post.mock.calls[callIndex][1] as SealDocumentDto;
}

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'seal-1', ...data })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

describe('Integración: sellado al completarse la firma avanzada (FIEL)', () => {
  let service: DocumentService;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let sealRepository: ReturnType<typeof createMockRepository>;
  let configValues: Record<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = { ...SEAL_CONFIG };
    mockedAxios.post.mockResolvedValue({ data: PROVIDER_RESPONSE });
    mockedAxios.isAxiosError.mockImplementation(
      (error: unknown): error is never =>
        Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
    );

    documentRepository = createMockRepository();
    collaboratorRepository = createMockRepository();
    sealRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Cadena real bajo prueba.
        DocumentService,
        SealDocumentUseCase,
        SealApiService,
        // Bordes del sistema.
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        { provide: getRepositoryToken(SealEntity), useValue: sealRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
        {
          provide: MinioService,
          useValue: {
            getFileInBytesFormat: jest
              .fn()
              .mockResolvedValue(Buffer.from('pdf')),
            uploadPdfAObject: jest.fn().mockResolvedValue(undefined),
            getFile: jest.fn(),
            uploadObject: jest.fn(),
            deleteFile: jest.fn(),
            replaceFile: jest.fn(),
          },
        },
        {
          provide: HashService,
          useValue: {
            generateFileHash: jest.fn().mockResolvedValue('hash-firmado'),
            generateCiperHash: jest.fn().mockResolvedValue('cifrado'),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'user-1', email: 'creador@correo.com' }),
          },
        },
        {
          provide: PdfSignatureService,
          useValue: {
            mergeSignatureIntoPdf: jest.fn(),
            resolveRatioPosition: jest.fn(),
            getPdfPages: jest.fn(),
            stampRejectedWatermark: jest.fn(),
            stampCancelledWatermark: jest.fn(),
            appendPdfPages: jest
              .fn()
              .mockResolvedValue(Buffer.from('pdf-final')),
          },
        },
        {
          // La hoja de firmas se anexa dentro de la misma finalización que dispara el sellado
          // (ver historia "Anexar hoja existente de información de firmas al documento final").
          provide: SummaryDocumentService,
          useValue: {
            generateSummaryPdf: jest
              .fn()
              .mockResolvedValue(Buffer.from('hoja-de-firmas')),
          },
        },
        {
          // Estos documentos son FIEL, así que la hoja que se anexa es la avanzada.
          provide: AdvancedSummaryDocumentService,
          useValue: {
            generateAdvancedSummaryPdf: jest
              .fn()
              .mockResolvedValue(Buffer.from('hoja-de-firmas-avanzada')),
          },
        },
        // Servicio real: el QR de cada firma avanzada se genera dentro de la misma finalización
        // que dispara el sellado, así que la cadena bajo prueba lo ejercita de verdad.
        SignatureQrService,
        { provide: SignatureService, useValue: { findOne: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendDocumentSignedNotification: jest.fn(),
            sendDocumentCompletedToCreatorNotification: jest.fn(),
            sendDocumentPendingNotification: jest.fn(),
          },
        },
        { provide: AuditService, useValue: { create: jest.fn() } },
        {
          provide: DocumentEventsProducer,
          useValue: {
            emitSigned: jest.fn(),
            emitCollaboratorSigned: jest.fn(),
          },
        },
        {
          provide: AccountMemberService,
          useValue: {
            findPersonalAccountId: jest
              .fn()
              .mockImplementation((userId: string) =>
                Promise.resolve(`account-of-${userId}`),
              ),
          },
        },
        {
          provide: VerificationCodeService,
          useValue: { hasConsumedCode: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: DocumentTransactionService,
          useValue: { registerSignature: jest.fn() },
        },
        {
          provide: EfirmaService,
          useValue: {
            // Forma real de `SignatureResult` (ver src/efirma/interfaces).
            firmar: jest.fn().mockReturnValue({
              originalHash: 'hash-original',
              signatureBase64: 'firma-de-user-1',
              algorithm: 'sha256',
              signedAt: new Date('2026-08-13T18:45:56.000Z'),
              certificate: {
                rfc: 'PEAJ800101XXX',
                name: 'JUAN PEREZ',
                serialNumber: '00001000000512345678',
                certificateNumber: '30001000000500003416',
                certificatePem:
                  '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
              },
            }),
          },
        },
      ],
    }).compile();

    service = module.get(DocumentService);
  });

  it('el último firmante FIEL dispara UNA petición a Seal Service con el documentId, el arreglo de firmas y la API key', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    const result = await service.sign(
      'doc-1',
      'user-1',
      EFIRMA_INPUT,
      TEST_GEOLOCATION,
    );

    expect(result.success).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    const [url, , config] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('http://seal-service:3000/seal/signature');
    expect(config).toEqual(
      expect.objectContaining({
        headers: { 'x-api-key': 'api-key-de-prueba' },
      }),
    );
    expect(sentPayload()).toEqual({
      documentId: 'doc-1',
      originalHash: 'hash-original',
      signatures: [
        {
          signatureBase64: 'firma-de-user-1',
          algorithm: 'sha256',
          signedAt: '2026-08-13T18:45:56.000Z',
          certificate: {
            rfc: 'PEAJ800101XXX',
            name: 'JUAN PEREZ',
            serialNumber: '00001000000512345678',
            certificateNumber: '30001000000500003416',
            certificatePem:
              '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
          },
        },
      ],
    });
  });

  it('persiste la evidencia que devuelve Seal Service en document_seals', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    await service.sign('doc-1', 'user-1', EFIRMA_INPUT, TEST_GEOLOCATION);

    expect(sealRepository.save).toHaveBeenCalledWith({
      documentId: 'doc-1',
      signatureHash: 'f00dcafe',
      // La preimagen del hash, tal como la devolvió el proveedor.
      canonicalPayload: 'v1||13:hash-original|5:doc-1||...',
      timestampSeal: {
        isValid: true,
        processedHash: 'f00dcafe',
        tokenBase64: 'tsr-en-base64',
        evidenceId: 'ts-uuid',
      },
      integritySeal: {
        isValid: true,
        processedHash: 'f00dcafe',
        tokenBase64: 'nom151-en-base64',
        evidenceId: 'nom-uuid',
        certificatePdfBase64: 'pdf-en-base64',
      },
    });
    expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
  });

  it('con varios firmantes FIEL, sella una sola vez y manda las firmas de todos', async () => {
    const document = mockDocument({ totalSigners: 2 });
    documentRepository.findOne.mockResolvedValue(document);
    const yaFirmo = buildFielSigner({
      id: 'p-a',
      userId: 'user-a',
      signingOrder: 0,
      status: SIGNEE_STATUS_ENUM.SIGNED,
      advancedSignature: {
        originalHash: 'hash-original',
        signatureBase64: 'firma-de-user-a',
        algorithm: 'sha256',
        // Llega como string porque se releyó de la columna jsonb, no como Date.
        signedAt: '2026-08-10T10:00:00.000Z',
        certificate: {
          rfc: 'AAAA010101AAA',
          name: 'FIRMANTE A',
          serialNumber: '1',
          certificateNumber: '2',
          certificatePem: 'pem-a',
        },
      },
    } as unknown as Partial<CollaboratorEntity>);
    const ultimo = buildFielSigner({
      id: 'p-b',
      userId: 'user-b',
      signingOrder: 1,
    });
    collaboratorRepository.find.mockResolvedValue([yaFirmo, ultimo]);

    await service.sign('doc-1', 'user-b', EFIRMA_INPUT, TEST_GEOLOCATION);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const body = sentPayload();
    expect(body.signatures).toHaveLength(2);
    expect(body.signatures.map((s) => s.signatureBase64)).toEqual([
      'firma-de-user-a',
      'firma-de-user-1',
    ]);
    // Las dos rutas (Date recién firmada / string releído de jsonb) producen el mismo formato.
    expect(body.signatures.map((s) => s.signedAt)).toEqual([
      '2026-08-10T10:00:00.000Z',
      '2026-08-13T18:45:56.000Z',
    ]);
  });

  it('mientras falte un firmante, no se llama a Seal Service', async () => {
    const document = mockDocument({ totalSigners: 2 });
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ id: 'p-a', userId: 'user-a', signingOrder: 0 }),
      buildFielSigner({ id: 'p-b', userId: 'user-b', signingOrder: 1 }),
    ]);

    await service.sign('doc-1', 'user-a', EFIRMA_INPUT, TEST_GEOLOCATION);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(sealRepository.save).not.toHaveBeenCalled();
  });

  describe('el sellado nunca invalida una firma ya registrada', () => {
    // Escenario real desde que Seal Service monta su ApiGuard global: si SEAL_SERVICE_API_KEY no
    // coincide con el API_KEY del otro lado, toda petición de sellado vuelve con 401.
    it('API key rechazada por Seal Service (401): la firma queda registrada y no se persiste evidencia', async () => {
      mockedAxios.post.mockRejectedValue({
        isAxiosError: true,
        response: { status: 401 },
      });
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await service.sign(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(sealRepository.save).not.toHaveBeenCalled();
    });

    it('Seal Service inalcanzable: la firma se completa igual', async () => {
      mockedAxios.post.mockRejectedValue({
        isAxiosError: true,
        code: 'ECONNREFUSED',
      });
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await service.sign(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
    });

    it('respuesta del proveedor sin los campos que se persisten: se rechaza sin escribir una evidencia a medias', async () => {
      const { hashHex: _omitted, ...incompleta } = PROVIDER_RESPONSE;
      mockedAxios.post.mockResolvedValue({ data: incompleta });
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await service.sign(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(sealRepository.save).not.toHaveBeenCalled();
    });

    it('documento ya sellado (violación de unicidad): la firma se completa igual', async () => {
      sealRepository.save.mockRejectedValue(
        new QueryFailedError('INSERT INTO document_seals', [], {
          code: '23505',
        } as unknown as Error),
      );
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await service.sign(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
    });

    it('sin configuración de Seal Service, el documento se firma igual y no se llama a la red', async () => {
      configValues = {};
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await service.sign(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
