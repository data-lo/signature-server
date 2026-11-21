import { Test, TestingModule } from '@nestjs/testing';
import { CloseBiometricReservationsUseCase } from 'src/billing/credits/close-biometric-reservations.use-case';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import axios from 'axios';

import { DocumentService } from '../document.service';
import { SignDocumentUseCase } from '../applications/sign-document.use-case';
import { DocumentAuthorizationPolicy } from '../policies/document-authorization.policy';
import { DocumentEntity } from '../entities/document.entity';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { BiometricSignatureAttemptEntity } from 'src/biometric-signature/entities/biometric-signature-attempt.entity';
import { VerificationCodeEntity } from '../entities/verification-code.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { MinioService } from 'src/common/minio/minio.service';
import { HashService } from 'src/common/hash/hash.service';
import { UserService } from 'src/user/user.service';
import { PdfSignatureService } from 'src/common/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/common/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from '../verification-code.service';
import { DocumentTransactionService } from '../document-transaction.service';
import { EfirmaService } from 'src/efirma/efirma.service';
import { SummaryDocumentService } from '../summary-document/summary-document.service';
import { AdvancedSummaryDocumentService } from '../summary-document/advanced-summary-document.service';
import { SignatureQrService } from '../services/signature-qr.service';
import { GuestSigningAccessService } from '../services/guest-signing-access.service';

import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { SealingRequestSnapshotService } from './services/sealing-request-snapshot.service';
import { RegisterDocumentSealingJobUseCase } from './use-cases/register-document-sealing-job.use-case';
import { SEALING_TYPE_ENUM } from './enums/sealing-type.enum';
import { SEALING_JOB_STATUS_ENUM } from './enums/sealing-job-status.enum';
import { SealApiService } from './services/seal-api.service';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentDto } from './dto/seal-document.dto';
import { SealDocumentResponse } from './interfaces/seal-document-response.interface';
import { SigningLinkService } from 'src/signing-invitation/signing-link.service';

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
    status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
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
    status: COLLABORATOR_STATUS_ENUM.PENDING,
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
  const repository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'seal-1', ...data })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    // Marcar SIGNED va en transacción (con el cierre de reservas biométricas): dentro de ella,
    // `getRepository` devuelve este mismo mock.
    manager: { transaction: jest.fn() },
  };
  repository.manager.transaction.mockImplementation(
    async (work: (manager: unknown) => unknown) =>
      work({ getRepository: () => repository }),
  );
  return repository;
}

/**
 * Cada caso recorre la finalización completa —incluido el render real de la hoja de evidencia con
 * pdfmake, que carga las tipografías de disco— y ronda el segundo cuando el archivo corre solo.
 * Los 5 s por defecto de Jest alcanzaban justo, pero se agotaban al correr la suite entera en
 * paralelo: el spec fallaba por timeout de forma intermitente, sin que nada estuviera roto.
 */
jest.setTimeout(30_000);

describe('Integración: cierre y sellado de la firma avanzada (FIEL)', () => {
  let signDocument: SignDocumentUseCase;
  let documentService: DocumentService;
  let registerSealingJob: { execute: jest.Mock };
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

    registerSealingJob = {
      execute: jest.fn().mockResolvedValue({
        job: {
          id: 'job-1',
          status: SEALING_JOB_STATUS_ENUM.PENDING,
          requestObjectKey: null,
        },
        created: true,
      }),
    };
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
        'addSelect',
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
        // Enlace de firma real: `/access-document` salvo en documentos de integración.
        {
          provide: SigningLinkService,
          useValue: new SigningLinkService({
            issue: jest.fn(async () => ({ url: 'http://app/sign/token' })),
          } as never),
        },
        // Cadena real bajo prueba.
        SignDocumentUseCase,
        DocumentAuthorizationPolicy,
        DocumentService,
        {
          provide: CloseBiometricReservationsUseCase,
          useValue: { execute: jest.fn().mockResolvedValue({ consumed: 0 }) },
        },
        SealDocumentUseCase,
        SealApiService,
        {
          provide: SealingRequestSnapshotService,
          useValue: {
            freezeSimpleSignatureRequest: jest.fn(),
            discard: jest.fn(),
          },
        },
        {
          provide: RegisterDocumentSealingJobUseCase,
          useValue: registerSealingJob,
        },
        // Bordes del sistema.
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        // Este flujo firma con FIEL y simple: nunca consulta intentos biométricos.
        {
          provide: getRepositoryToken(BiometricSignatureAttemptEntity),
          useValue: { findOne: jest.fn() },
        },
        // Firman usuarios con cuenta: sólo se revocan (sin efecto) los accesos de invitado.
        {
          provide: GuestSigningAccessService,
          useValue: {
            revokeOpenForCollaborator: jest.fn().mockResolvedValue(0),
            revokeOpenForDocument: jest.fn().mockResolvedValue(0),
          },
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
            // La firma producida se verifica contra el documento antes de registrarla.
            verificar: jest.fn().mockReturnValue({
              esValida: true,
              hashCoincide: true,
              firmaValida: true,
            }),
            calcularHashDocumento: jest.fn().mockReturnValue('hash-original'),
          },
        },
      ],
    }).compile();

    signDocument = module.get(SignDocumentUseCase);
  });

  it('el último firmante FIEL dispara UNA petición a Seal Service con el documentId, el arreglo de firmas y la API key', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    const result = await signDocument.execute(
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
        headers: {
          'x-api-key': 'api-key-de-prueba',
          // La misma clave en cada ejecución del sellado de este documento.
          'Idempotency-Key': 'signature-server:document:doc-1:v1',
        },
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

    await signDocument.execute(
      'doc-1',
      'user-1',
      EFIRMA_INPUT,
      TEST_GEOLOCATION,
    );

    const rutas = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(rutas).toEqual(['http://seal-service:3000/seal/signature']);
  });

  it('persiste la evidencia que devuelve Seal Service en document_seals', async () => {
    const document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([
      buildFielSigner({ userId: 'user-1' }),
    ]);

    await signDocument.execute(
      'doc-1',
      'user-1',
      EFIRMA_INPUT,
      TEST_GEOLOCATION,
    );

    expect(sealRepository.save).toHaveBeenCalledWith({
      documentId: 'doc-1',
      signatureHash: 'f00dcafe',
      // La preimagen del hash, tal como la devolvió el proveedor.
      canonicalPayload: 'v1||13:hash-original|5:doc-1||...',
      // El momento de emisión que reporta el PSC: se persiste porque la respuesta es la única
      // oportunidad de guardarlo, y es lo que la hoja de evidencia imprime como "EMITIDO".
      sealedAt: new Date('2026-08-13T19:00:00.000Z'),
      timestampEvidence: {
        isValid: true,
        processedHash: 'f00dcafe',
        fileBase64: 'tsr-en-base64',
        evidenceId: 'ts-uuid',
        issuedAt: new Date('2026-08-13T19:00:00.000Z'),
      },
      integrityEvidence: {
        isValid: true,
        processedHash: 'f00dcafe',
        fileBase64: 'nom151-en-base64',
        evidenceId: 'nom-uuid',
        issuedAt: new Date('2026-08-13T19:00:00.000Z'),
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

    await signDocument.execute(
      'doc-1',
      'user-1',
      EFIRMA_INPUT,
      TEST_GEOLOCATION,
    );

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

    await signDocument.execute(
      'doc-1',
      'user-1',
      EFIRMA_INPUT,
      TEST_GEOLOCATION,
    );

    const [info] =
      advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock.calls[0];
    expect(info.conservationRecord).toBeNull();
    expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
  });

  /**
   * Historia "Persistir y registrar trabajos de sellado al completar la firma": cerrar un documento
   * FIEL ya no llama a Seal Service. Deja la firma del último firmante, el documento en SIGNED y un
   * trabajo `ADVANCED` en la misma transacción; el sellado lo hace después un worker.
   */
  describe('al cerrar el documento', () => {
    it('el último firmante FIEL registra un trabajo ADVANCED y no llama a Seal Service', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(registerSealingJob.execute).toHaveBeenCalledWith(
        {
          documentId: 'doc-1',
          sealType: SEALING_TYPE_ENUM.ADVANCED,
          request: null,
          blocker: null,
        },
        expect.anything(),
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(sealRepository.save).not.toHaveBeenCalled();
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(document.sealingPendingAt).toEqual(expect.any(Date));
    });

    it('arma la hoja inicial sin constancia: la agrega el worker', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      const [info] =
        advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock.calls[0];
      expect(info.conservationRecord).toBeNull();
    });

    it('guarda la firma avanzada del último firmante dentro de la transacción de cierre', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      // Dentro de la transacción, el manager simulado devuelve el repositorio de documentos.
      expect(documentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'collaborator-1',
          advancedSignature: expect.objectContaining({
            signatureBase64: 'firma-de-user-1',
            ocspEvidence: expect.objectContaining({ status: 'good' }),
          }),
        }),
      );
    });

    it('mientras falte un firmante, no registra trabajo ni llama a Seal Service', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ totalSigners: 2 }),
      );
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ id: 'p-a', userId: 'user-a', signingOrder: 0 }),
        buildFielSigner({ id: 'p-b', userId: 'user-b', signingOrder: 1 }),
      ]);

      await signDocument.execute(
        'doc-1',
        'user-a',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(registerSealingJob.execute).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('sin configuración de Seal Service, el documento se cierra igual', async () => {
      configValues = {};
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.find.mockResolvedValue([
        buildFielSigner({ userId: 'user-1' }),
      ]);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        EFIRMA_INPUT,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(registerSealingJob.execute).toHaveBeenCalled();
    });
  });

  /**
   * `sealAdvancedSignatures` sigue vivo para los documentos firmados antes de
   * `document_sealing_jobs`, que la vista pública sella de forma oportunista. Se prueba la cadena
   * real DocumentService → SealDocumentUseCase → SealApiService → SealMapper con firmas tal como
   * quedan persistidas.
   */
  describe('sellado avanzado de documentos sin trabajo (`sealAdvancedSignatures`)', () => {
    const FRESH_SIGNATURE = {
      originalHash: 'hash-original',
      signatureBase64: 'firma-de-user-1',
      algorithm: 'sha256',
      // Recién firmada: fechas como `Date`.
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
      ocspEvidence: {
        status: 'good',
        verifiedAt: new Date('2026-08-13T18:45:56.000Z'),
        ocspResponse: 'respuesta-ocsp-en-base64',
        ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
      },
    };

    /** Firma releída de la columna jsonb: las fechas llegan como string. */
    const JSONB_SIGNATURE = {
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
      ocspEvidence: {
        status: 'good',
        verifiedAt: '2026-08-10T10:00:01.000Z',
        ocspResponse: 'respuesta-ocsp-de-user-a',
        ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
      },
    };

    function signedSigner(
      advancedSignature: unknown,
      overrides: Partial<CollaboratorEntity> & { userId?: string } = {},
    ) {
      return buildFielSigner({
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
        advancedSignature,
        ...overrides,
      } as unknown as Partial<CollaboratorEntity>);
    }

    it('manda UNA petición a Seal Service con el documentId, el arreglo de firmas y la API key', async () => {
      const seal = await documentService.sealAdvancedSignatures(
        mockDocument(),
        [signedSigner(FRESH_SIGNATURE)],
      );

      expect(seal).not.toBeNull();
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
            certificate: FRESH_SIGNATURE.certificate,
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

    it('persiste la evidencia que devuelve Seal Service en document_seals', async () => {
      await documentService.sealAdvancedSignatures(mockDocument(), [
        signedSigner(FRESH_SIGNATURE),
      ]);

      expect(sealRepository.save).toHaveBeenCalledWith({
        documentId: 'doc-1',
        signatureHash: 'f00dcafe',
        canonicalPayload: 'v1||13:hash-original|5:doc-1||...',
        sealedAt: new Date('2026-08-13T19:00:00.000Z'),
        timestampEvidence: {
          isValid: true,
          processedHash: 'f00dcafe',
          fileBase64: 'tsr-en-base64',
          evidenceId: 'ts-uuid',
          issuedAt: new Date('2026-08-13T19:00:00.000Z'),
        },
        integrityEvidence: {
          isValid: true,
          processedHash: 'f00dcafe',
          fileBase64: 'nom151-en-base64',
          evidenceId: 'nom-uuid',
          issuedAt: new Date('2026-08-13T19:00:00.000Z'),
          certificatePdfBase64: 'pdf-en-base64',
        },
      });
    });

    it('con varios firmantes, sella una sola vez y normaliza las fechas de jsonb y de Date', async () => {
      await documentService.sealAdvancedSignatures(mockDocument(), [
        signedSigner(JSONB_SIGNATURE, { id: 'p-a', userId: 'user-a' }),
        signedSigner(FRESH_SIGNATURE, { id: 'p-b', userId: 'user-b' }),
      ]);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const body = sentPayload();
      expect(body.signatures.map((s) => s.signatureBase64)).toEqual([
        'firma-de-user-a',
        'firma-de-user-1',
      ]);
      expect(body.signatures.map((s) => s.signedAt)).toEqual([
        '2026-08-10T10:00:00.000Z',
        '2026-08-13T18:45:56.000Z',
      ]);
      // Regresión: `verifiedAt` como string rompía el sellado de todo documento multi-firmante.
      expect(body.signatures[0].ocspEvidence).toEqual(
        JSONB_SIGNATURE.ocspEvidence,
      );
    });

    it('no sella una firma sin evidencia OCSP: deja el documento pendiente', async () => {
      const document = mockDocument();
      const { ocspEvidence: _omit, ...withoutOcsp } = JSONB_SIGNATURE;

      const seal = await documentService.sealAdvancedSignatures(document, [
        signedSigner(withoutOcsp),
      ]);

      expect(seal).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(documentRepository.update).toHaveBeenCalledWith(
        document.id,
        expect.objectContaining({ sealingPendingAt: expect.any(Date) }),
      );
    });

    it('si el documento ya estaba sellado, devuelve la constancia existente', async () => {
      sealRepository.save.mockRejectedValue(
        new QueryFailedError('INSERT INTO document_seals', [], {
          code: '23505',
        } as unknown as Error),
      );
      sealRepository.findOne.mockResolvedValue({
        id: 'seal-previo',
        documentId: 'doc-1',
      });

      const seal = await documentService.sealAdvancedSignatures(
        mockDocument(),
        [signedSigner(FRESH_SIGNATURE)],
      );

      expect(seal).toEqual(expect.objectContaining({ id: 'seal-previo' }));
    });

    describe('un fallo del proveedor nunca lanza', () => {
      it('API key rechazada (401): devuelve null y no persiste evidencia', async () => {
        mockedAxios.post.mockRejectedValue({
          isAxiosError: true,
          response: { status: 401 },
        });

        await expect(
          documentService.sealAdvancedSignatures(mockDocument(), [
            signedSigner(FRESH_SIGNATURE),
          ]),
        ).resolves.toBeNull();
        expect(sealRepository.save).not.toHaveBeenCalled();
      });

      it('Seal Service inalcanzable: devuelve null', async () => {
        mockedAxios.post.mockRejectedValue({
          isAxiosError: true,
          code: 'ECONNREFUSED',
        });

        await expect(
          documentService.sealAdvancedSignatures(mockDocument(), [
            signedSigner(FRESH_SIGNATURE),
          ]),
        ).resolves.toBeNull();
      });

      it('respuesta sin los campos que se persisten: no escribe una evidencia a medias', async () => {
        const { hashHex: _omitted, ...incompleta } = PROVIDER_RESPONSE;
        mockedAxios.post.mockResolvedValue({ data: incompleta });

        await expect(
          documentService.sealAdvancedSignatures(mockDocument(), [
            signedSigner(FRESH_SIGNATURE),
          ]),
        ).resolves.toBeNull();
        expect(sealRepository.save).not.toHaveBeenCalled();
      });

      it('sin configuración de Seal Service: devuelve null sin llamar a la red', async () => {
        configValues = {};

        await expect(
          documentService.sealAdvancedSignatures(mockDocument(), [
            signedSigner(FRESH_SIGNATURE),
          ]),
        ).resolves.toBeNull();
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });
    });
  });
});
