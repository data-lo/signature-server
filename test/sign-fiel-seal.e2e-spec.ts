import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import axios from 'axios';

import { DocumentController } from './../src/document/document.controller';
import { DocumentService } from './../src/document/document.service';
import { SignDocumentUseCase } from './../src/document/applications/sign-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './../src/document/seal/use-cases/send-completed-simple-signature-to-seal.use-case';
import { AdvancedSummaryDocumentService } from './../src/document/summary-document/advanced-summary-document.service';
import { SignatureQrService } from './../src/document/services/signature-qr.service';
import { DOCUMENT_CONTROLLER_USE_CASE_STUBS } from './document-controller-use-case-stubs';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from './../src/document/enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './../src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from './../src/document/enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from './../src/document/enum/signature-type.enum';
import { MinioService } from './../src/shared/minio/minio.service';
import { HashService } from './../src/shared/hash/hash.service';
import { UserService } from './../src/user/user.service';
import { PdfSignatureService } from './../src/shared/document-signing/document-signing.service';
import { SignatureService } from './../src/signature/signature.service';
import { EmailService } from './../src/shared/email/email.service';
import { AuditService } from './../src/audit/audit.service';
import { DocumentEventsProducer } from './../src/kafka/document-events.producer';
import { AccountMemberService } from './../src/account/account-member.service';
import { VerificationCodeService } from './../src/document/verification-code.service';
import { DocumentTransactionService } from './../src/document/document-transaction.service';
import { EfirmaService } from './../src/efirma/efirma.service';
import { SummaryDocumentService } from './../src/document/summary-document/summary-document.service';
import { SealDocumentUseCase } from './../src/document/seal/use-cases/seal-document.use-case';
import { SealApiService } from './../src/document/seal/services/seal-api.service';
import { SealEntity } from './../src/document/seal/entities/seal.entity';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SIGNER_USER_ID = 'user-1';
const DOCUMENT_ID = 'doc-1';
const SEAL_SERVICE_URL = 'http://seal-service:3002';
const SEAL_API_KEY = 'api-key-de-pruebas-e2e';

const GEOLOCATION = { latitude: 19.4326, longitude: -99.1332, accuracy: 15 };

/** Respuesta de `POST /seal/signature` de Seal Service (rama development). */
const SEAL_RESPONSE = {
  documentId: DOCUMENT_ID,
  hashHex: 'a'.repeat(64),
  hashAlgorithm: 'sha256',
  hashVersion: 'v1',
  canonicalString: 'v1||27:hash-original-del-documento|5:doc-1||...',
  sealedAt: '2026-08-13T19:00:00.000Z',
  timeStamp: {
    status: true,
    hashProcessed: 'a'.repeat(64),
    fileBase64: 'tsr-en-base64',
    uuid: 'ts-uuid',
  },
  nom151: {
    status: true,
    hashProcessed: 'a'.repeat(64),
    file: 'nom151-en-base64',
    uuid: 'nom-uuid',
    pdfFile: 'pdf-en-base64',
  },
};

const EFIRMA_RESULT = {
  originalHash: 'hash-original-del-documento',
  signatureBase64: 'firma-criptografica-en-base64',
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
};

/** Sustituye al `JwtAuthGuard` global (vive en AuthModule, que no se importa acá). */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { sub: SIGNER_USER_ID };
    return true;
  }
}

function mockDocument(): DocumentEntity {
  return {
    id: DOCUMENT_ID,
    fileName: 'contrato.pdf',
    objectKey: 'object-key-1',
    originalHash: 'hash-original-del-documento',
    status: DOCUMENT_STATUS_ENUM.PENDING,
    isSequential: true,
    totalSigners: 1,
    completedSignersCount: 0,
    requiresVerification: false,
    createdBy: 'creator-1',
    ipAddress: '127.0.0.1',
  } as DocumentEntity;
}

function buildFielSigner(): CollaboratorEntity {
  return {
    id: 'collaborator-1',
    documentId: DOCUMENT_ID,
    accountId: `account-of-${SIGNER_USER_ID}`,
    email: null,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: 0,
    ipAddress: '127.0.0.1',
    account: {
      id: `account-of-${SIGNER_USER_ID}`,
      userId: SIGNER_USER_ID,
      user: { id: SIGNER_USER_ID, firstName: 'Juan', lastName: 'Pérez' },
    },
  } as unknown as CollaboratorEntity;
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

/**
 * End-to-end del firmado con e.firma (FIEL) y su sellado.
 *
 * Entra por la ruta HTTP real (`PATCH /document/:id/sign`, multipart con .key/.cer) y recorre sin
 * dobles: interceptor de archivos → ValidationPipe global → DocumentController → DocumentService →
 * SealDocumentUseCase → SealApiService. Se sustituye únicamente lo que sale del proceso: la base
 * de datos, MinIO/Kafka/correo, la red hacia Seal Service (axios) y `EfirmaService`, que exigiría
 * un .cer/.key reales del SAT.
 */
describe('Firma con e.firma (FIEL) y sellado (e2e)', () => {
  let app: INestApplication;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let sealRepository: ReturnType<typeof createMockRepository>;
  let efirmaService: { firmar: jest.Mock };
  let document: DocumentEntity;

  function signRequest() {
    return request(app.getHttpServer())
      .patch(`/document/${DOCUMENT_ID}/sign`)
      .field('geolocation', JSON.stringify(GEOLOCATION))
      .field('password', 'clave-de-la-llave');
  }

  function withEfirmaFiles(pending: request.Test) {
    return pending
      .attach('key', Buffer.from('contenido-key'), 'llave.key')
      .attach('cer', Buffer.from('contenido-cer'), 'certificado.cer');
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ data: SEAL_RESPONSE });
    mockedAxios.isAxiosError.mockImplementation(
      (error: unknown): error is never =>
        Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
    );

    documentRepository = createMockRepository();
    collaboratorRepository = createMockRepository();
    sealRepository = createMockRepository();
    efirmaService = { firmar: jest.fn().mockReturnValue(EFIRMA_RESULT) };

    document = mockDocument();
    documentRepository.findOne.mockResolvedValue(document);
    collaboratorRepository.find.mockResolvedValue([buildFielSigner()]);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        // El endpoint bajo prueba entra por su caso de uso real; los otros 16 del controller se
        // sustituyen por dobles inertes, porque Nest exige resolver todo el constructor aunque
        // esta prueba sólo ejercite `PATCH /document/:id/sign`.
        SignDocumentUseCase,
        ...DOCUMENT_CONTROLLER_USE_CASE_STUBS,
        DocumentService,
        SealDocumentUseCase,
        SealApiService,
        {
          provide: SendCompletedSimpleSignatureToSealUseCase,
          useValue: { execute: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: AdvancedSummaryDocumentService,
          useValue: {
            generateAdvancedSummaryPdf: jest
              .fn()
              .mockResolvedValue(Buffer.from('hoja-de-firmas-avanzada')),
          },
        },
        {
          provide: SignatureQrService,
          useValue: {
            generateAdvancedSignaturePng: jest
              .fn()
              .mockResolvedValue(Buffer.from('qr-png')),
          },
        },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
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
          useValue: {
            get: jest.fn(
              (key: string) =>
                ({
                  SEAL_SERVICE_URL,
                  SEAL_SERVICE_API_KEY: SEAL_API_KEY,
                })[key],
            ),
          },
        },
        {
          provide: MinioService,
          useValue: {
            getFileInBytesFormat: jest
              .fn()
              .mockResolvedValue(Buffer.from('%PDF-1.4')),
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
            generateFileHash: jest.fn().mockResolvedValue('hash-del-firmado'),
            generateCiperHash: jest.fn().mockResolvedValue('cifrado'),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: SIGNER_USER_ID,
              email: 'creador@correo.com',
            }),
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
              .mockResolvedValue(Buffer.from('pdf-con-hoja')),
          },
        },
        {
          provide: SummaryDocumentService,
          useValue: {
            generateSummaryPdf: jest
              .fn()
              .mockResolvedValue(Buffer.from('hoja-de-firmas')),
          },
        },
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
              .mockResolvedValue(`account-of-${SIGNER_USER_ID}`),
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
        { provide: EfirmaService, useValue: efirmaService },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mismo pipe global que monta main.ts: es lo que transforma el `geolocation` serializado del
    // multipart en una instancia de GeolocationDto y valida sus rangos.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('camino completo', () => {
    it('firma con e.firma, marca el documento como firmado y sella con Seal Service', async () => {
      const response = await withEfirmaFiles(signRequest()).expect(200);

      expect(response.body.success).toBe(true);

      // 1. La e.firma se validó con los archivos y la contraseña que llegaron por multipart.
      expect(efirmaService.firmar).toHaveBeenCalledWith(
        Buffer.from('%PDF-1.4'),
        Buffer.from('contenido-cer'),
        Buffer.from('contenido-key'),
        'clave-de-la-llave',
      );

      // 2. El resultado no sensible quedó en el colaborador.
      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SIGNEE_STATUS_ENUM.SIGNED,
          advancedSignature: expect.objectContaining({
            signatureBase64: 'firma-criptografica-en-base64',
          }),
        }),
      );

      // 3. El documento quedó firmado.
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
    });

    it('manda a Seal Service el documentId, el arreglo de firmas y la API key', async () => {
      await withEfirmaFiles(signRequest()).expect(200);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockedAxios.post.mock.calls[0];

      expect(url).toBe(`${SEAL_SERVICE_URL}/seal/signature`);
      expect(config).toEqual(
        expect.objectContaining({ headers: { 'x-api-key': SEAL_API_KEY } }),
      );
      expect(body).toEqual({
        documentId: DOCUMENT_ID,
        originalHash: 'hash-original-del-documento',
        signatures: [
          {
            signatureBase64: 'firma-criptografica-en-base64',
            algorithm: 'sha256',
            signedAt: '2026-08-13T18:45:56.000Z',
            certificate: EFIRMA_RESULT.certificate,
          },
        ],
      });
    });

    it('persiste la evidencia devuelta, con la cadena canónica que hace verificable el sello', async () => {
      await withEfirmaFiles(signRequest()).expect(200);

      expect(sealRepository.save).toHaveBeenCalledWith({
        documentId: DOCUMENT_ID,
        signatureHash: SEAL_RESPONSE.hashHex,
        canonicalPayload: SEAL_RESPONSE.canonicalString,
        // El momento de emisión que reporta el PSC, no cuándo insertamos la fila: es lo que la
        // hoja de evidencia imprime como "EMITIDO" (ver SealMapper).
        sealedAt: new Date(SEAL_RESPONSE.sealedAt),
        timestampEvidence: {
          isValid: true,
          processedHash: SEAL_RESPONSE.hashHex,
          fileBase64: 'tsr-en-base64',
          evidenceId: 'ts-uuid',
          issuedAt: new Date(SEAL_RESPONSE.sealedAt),
        },
        integrityEvidence: {
          isValid: true,
          processedHash: SEAL_RESPONSE.hashHex,
          fileBase64: 'nom151-en-base64',
          evidenceId: 'nom-uuid',
          issuedAt: new Date(SEAL_RESPONSE.sealedAt),
          certificatePdfBase64: 'pdf-en-base64',
        },
      });
    });
  });

  describe('el sellado no puede invalidar una firma', () => {
    it('si Seal Service rechaza la API key (401), la firma se completa igual y no se guarda evidencia', async () => {
      mockedAxios.post.mockRejectedValue({
        isAxiosError: true,
        response: { status: 401 },
      });

      const response = await withEfirmaFiles(signRequest()).expect(200);

      expect(response.body.success).toBe(true);
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(sealRepository.save).not.toHaveBeenCalled();
    });

    it('si Seal Service está caído, la firma se completa igual', async () => {
      mockedAxios.post.mockRejectedValue({
        isAxiosError: true,
        code: 'ECONNREFUSED',
      });

      await withEfirmaFiles(signRequest()).expect(200);

      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
      expect(sealRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('la firma no llega a registrarse si la e.firma no es válida', () => {
    it('sin el archivo .key responde 400 y no sella nada', async () => {
      await signRequest()
        .attach('cer', Buffer.from('contenido-cer'), 'certificado.cer')
        .expect(400);

      expect(efirmaService.firmar).not.toHaveBeenCalled();
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('con la contraseña incorrecta responde 422, no marca al firmante y no sella', async () => {
      efirmaService.firmar.mockImplementation(() => {
        throw new UnprocessableEntityException('Contraseña incorrecta');
      });

      await withEfirmaFiles(signRequest()).expect(422);

      expect(collaboratorRepository.update).not.toHaveBeenCalled();
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.PENDING);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('sin geolocalización responde 400 antes de tocar la e.firma', async () => {
      await request(app.getHttpServer())
        .patch(`/document/${DOCUMENT_ID}/sign`)
        .field('password', 'clave-de-la-llave')
        .attach('key', Buffer.from('contenido-key'), 'llave.key')
        .attach('cer', Buffer.from('contenido-cer'), 'certificado.cer')
        .expect(400);

      expect(efirmaService.firmar).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
