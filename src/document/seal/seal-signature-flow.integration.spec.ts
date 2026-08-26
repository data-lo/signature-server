import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import axios from 'axios';

import { DocumentService } from '../document.service';
import { DocumentEntity } from '../entities/document.entity';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { VerificationCodeEntity } from '../entities/verification-code.entity';
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
import { SendCompletedSimpleSignatureToSealUseCase } from './use-cases/send-completed-simple-signature-to-seal.use-case';
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
  let verificationCodeRepository: ReturnType<typeof createMockRepository>;
  let advancedSummaryDocumentService: { generateAdvancedSummaryPdf: jest.Mock };
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
    verificationCodeRepository = createMockRepository();

    /**
     * El envío de firma simple relee el documento con sus colaboradores por `QueryBuilder`; acá
     * ese join se simula devolviendo lo mismo que ya tienen mockeados los dos repositorios. Estos
     * documentos son FIEL, así que lo que se comprueba es que ese camino se corte solo y no
     * agregue una segunda petición al proveedor.
     */
    documentRepository.createQueryBuilder.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        getOne: async () => ({
          ...(await documentRepository.findOne()),
          collaborators: await collaboratorRepository.find(),
        }),
      };
      for (const method of [
        'leftJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
      ]) {
        builder[method] = jest.fn(() => builder);
      }
      return builder;
    });

    advancedSummaryDocumentService = {
      generateAdvancedSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas-avanzada')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Cadena real bajo prueba.
        DocumentService,
        SealDocumentUseCase,
        SealApiService,
        SendCompletedSimpleSignatureToSealUseCase,
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
          provide: getRepositoryToken(VerificationCodeEntity),
          useValue: verificationCodeRepository,
        },
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
          useValue: advancedSummaryDocumentService,
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
                issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
                serialNumber: '00001000000512345678',
                certificateNumber: '30001000000500003416',
                certificatePem:
                  '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
              },
              // Evidencia OCSP de la consulta al SAT (`OscpService.verifyRevokedOCSP`): viaja
              // dentro del payload de sellado, así que sin ella el flujo ni siquiera llega a
              // Seal Service. Recién firmado, `verifiedAt` es un `Date`.
              ocspEvidence: {
                status: 'good',
                verifiedAt: new Date('2026-08-13T18:45:56.000Z'),
                ocspResponse: 'respuesta-ocsp-en-base64',
                ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
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
            issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
            serialNumber: '00001000000512345678',
            certificateNumber: '30001000000500003416',
            certificatePem:
              '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
          },
          // La evidencia OCSP sale hacia el proveedor con `verifiedAt` ya en ISO 8601, igual que
          // `signedAt`: el PSC canonicaliza el payload como texto.
          ocspEvidence: {
            status: 'good',
            verifiedAt: '2026-08-13T18:45:56.000Z',
            ocspResponse: 'respuesta-ocsp-en-base64',
            ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
          },
        },
      ],
    });
  });

  it('no manda estas firmas por la ruta de firma simple: son FIEL', async () => {
    documentRepository.findOne.mockResolvedValue(mockDocument());
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    await service.sign('doc-1', 'user-1', EFIRMA_INPUT, TEST_GEOLOCATION);

    const rutas = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(rutas).toEqual(['http://seal-service:3000/seal/signature']);
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
      // El momento de emisión que reporta el PSC: se persiste porque la respuesta es la única
      // oportunidad de guardarlo, y es lo que la hoja de evidencia imprime como "EMITIDO".
      sealedAt: new Date('2026-08-13T19:00:00.000Z'),
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

  /**
   * El sellado corre ANTES de armar la hoja de evidencia. Antes era al revés, y por eso la tabla
   * "Información de la Constancia de Conservación (NOM-151)" salía siempre vacía: al imprimirla
   * todavía no existía la constancia.
   */
  it('sella antes de armar la hoja, y la hoja recibe la constancia emitida', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    const orden: string[] = [];
    sealRepository.save.mockImplementation(async (data: object) => {
      orden.push('sellado');
      return { id: 'seal-1', ...data };
    });
    advancedSummaryDocumentService.generateAdvancedSummaryPdf.mockImplementation(
      async () => {
        orden.push('hoja');
        return Buffer.from('hoja');
      },
    );

    await service.sign('doc-1', 'user-1', EFIRMA_INPUT, TEST_GEOLOCATION);

    expect(orden).toEqual(['sellado', 'hoja']);

    const [info] =
      advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock.calls[0];
    expect(info.conservationRecord).toEqual(
      expect.objectContaining({
        issuedAt: new Date('2026-08-13T19:00:00.000Z'),
      }),
    );
  });

  // El sellado es best-effort: si falla, la firma se completa igual y la hoja se arma sin
  // constancia, exactamente como antes de que existiera este orden.
  it('si el sellado falla, la hoja se arma sin constancia y el documento igual queda firmado', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);
    mockedAxios.post.mockRejectedValue(new Error('proveedor caído'));

    await service.sign('doc-1', 'user-1', EFIRMA_INPUT, TEST_GEOLOCATION);

    const [info] =
      advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock.calls[0];
    expect(info.conservationRecord).toBeNull();
    expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
  });

  /**
   * Un intento anterior selló pero falló más adelante y la firma se reintentó: el segundo sellado
   * choca contra la restricción única. La constancia existe, así que se relee en vez de perderla
   * y dejar la hoja sin ella.
   */
  it('si el documento ya estaba sellado, relee esa constancia para la hoja', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    const uniqueViolation = new QueryFailedError('', [], {
      code: '23505',
    } as unknown as Error);
    sealRepository.save.mockRejectedValue(uniqueViolation);
    sealRepository.findOne.mockResolvedValue({
      id: 'seal-previo',
      documentId: 'doc-1',
      sealedAt: new Date('2026-08-13T19:00:00.000Z'),
    });

    await service.sign('doc-1', 'user-1', EFIRMA_INPUT, TEST_GEOLOCATION);

    const [info] =
      advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock.calls[0];
    expect(info.conservationRecord).toEqual(
      expect.objectContaining({
        issuedAt: new Date('2026-08-13T19:00:00.000Z'),
      }),
    );
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
          issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
          serialNumber: '1',
          certificateNumber: '2',
          certificatePem: 'pem-a',
        },
        ocspEvidence: {
          status: 'good',
          // También string, por la misma razón que `signedAt`: se releyó de jsonb, donde no hay
          // tipo fecha. Es la ruta que rompía el sellado del último firmante.
          verifiedAt: '2026-08-10T10:00:00.000Z',
          ocspResponse: 'respuesta-ocsp-de-user-a',
          ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
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

  /**
   * Regresión del bug que dejaba SIN SELLAR a todo documento FIEL de más de un firmante.
   *
   * `advancedSignature` es una columna jsonb, y `sealAdvancedSignatures` relee del repositorio a
   * todos los firmantes: los anteriores al último llegan siempre deserializados, con las fechas
   * como string. `toSealSignature` llamaba `signature.ocspEvidence.verifiedAt.toISOString()`
   * directo, que sobre un string revienta con "toISOString is not a function". Como el sellado es
   * best-effort, el `try/catch` se tragaba la excepción: no había error visible, simplemente
   * ningún documento multi-firmante llegaba a sellarse y su hoja salía con la tabla NOM-151 vacía.
   *
   * El fixture de arriba no lo detectaba porque no traía `ocspEvidence` en absoluto — se escribió
   * antes de que existiera la verificación OCSP.
   */
  it('normaliza la fecha de la evidencia OCSP releída de jsonb, en vez de romper el sellado', async () => {
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
        signedAt: '2026-08-10T10:00:00.000Z',
        certificate: {
          rfc: 'AAAA010101AAA',
          name: 'FIRMANTE A',
          issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
          serialNumber: '1',
          certificateNumber: '2',
          certificatePem: 'pem-a',
        },
        // Igual que `signedAt`: al releerse de jsonb es un string, no un Date.
        ocspEvidence: {
          status: 'good',
          verifiedAt: '2026-08-10T10:00:01.000Z',
          ocspResponse: 'respuesta-ocsp-en-base64',
          ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
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

    // Lo que importa: el documento SÍ se selló. Antes del arreglo esto era 0 llamadas.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const body = sentPayload();
    expect(body.signatures[0].ocspEvidence).toEqual({
      status: 'good',
      verifiedAt: '2026-08-10T10:00:01.000Z',
      ocspResponse: 'respuesta-ocsp-en-base64',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    });
  });

  /**
   * Las firmas guardadas antes de que existiera la verificación OCSP no tienen esa evidencia, y
   * el proveedor no la usa para construir el hash. Sellar sin ella es correcto; que un documento
   * viejo se quede sin constancia por eso, no.
   */
  it('sella igual una firma que no trae evidencia OCSP, omitiendo el campo', async () => {
    const document = mockDocument({ totalSigners: 2 });
    documentRepository.findOne.mockResolvedValue(document);
    const sinEvidencia = buildFielSigner({
      id: 'p-a',
      userId: 'user-a',
      signingOrder: 0,
      status: SIGNEE_STATUS_ENUM.SIGNED,
      advancedSignature: {
        originalHash: 'hash-original',
        signatureBase64: 'firma-de-user-a',
        algorithm: 'sha256',
        signedAt: '2026-08-10T10:00:00.000Z',
        certificate: {
          rfc: 'AAAA010101AAA',
          name: 'FIRMANTE A',
          issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
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
    collaboratorRepository.find.mockResolvedValue([sinEvidencia, ultimo]);

    await service.sign('doc-1', 'user-b', EFIRMA_INPUT, TEST_GEOLOCATION);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const body = sentPayload();
    // El campo se omite; no se manda `undefined` ni un objeto a medio llenar.
    expect(body.signatures[0]).not.toHaveProperty('ocspEvidence');
    expect(body.signatures[0].signatureBase64).toBe('firma-de-user-a');
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
