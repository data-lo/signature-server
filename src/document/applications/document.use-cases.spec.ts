import { createHash } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentService } from '../document.service';
import { DocumentEntity } from '../entities/document.entity';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
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
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';
import { DocumentTransactionService } from '../document-transaction.service';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { EfirmaService } from 'src/efirma/efirma.service';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { RetryPendingSealUseCase } from '../seal/use-cases/retry-pending-seal.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from '../seal/use-cases/send-completed-simple-signature-to-seal.use-case';
import { SealEntity } from '../seal/entities/seal.entity';
import { SEAL_ARTIFACT_ENUM } from '../seal/seal-artifacts';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import {
  ADVANCED_SIGNATURE_BACKING_LABEL,
  ADVANCED_SIGNATURE_TYPE_LABEL,
  SIMPLE_SIGNATURE_BACKING_LABEL,
  SIMPLE_SIGNATURE_TYPE_LABEL,
} from '../summary-document/signature-legal-text';
import { SummaryDocumentService } from '../summary-document/summary-document.service';
import { AdvancedSummaryDocumentService } from '../summary-document/advanced-summary-document.service';
import { SignatureQrService } from '../services/signature-qr.service';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

// Use cases
import { CreateDocumentUseCase } from './create-document.use-case';
import { GetDocumentsUseCase } from './get-documents.use-case';
import { GetDocumentUseCase } from './get-document.use-case';
import { SignDocumentUseCase } from './sign-document.use-case';
import { RejectDocumentUseCase } from './reject-document.use-case';
import { RequestDocumentVerificationCodeUseCase } from './request-document-verification-code.use-case';
import { VerifyDocumentCodeUseCase } from './verify-document-code.use-case';
import { SubmitDocumentForCancellationUseCase } from './submit-document-for-cancellation.use-case';
import { ConfirmDocumentCancellationUseCase } from './confirm-document-cancellation.use-case';
import { GetPublicDocumentUseCase } from './get-public-document.use-case';
import { GetPublicSealArtifactUseCase } from './get-public-seal-artifact.use-case';
import { GetPublicAdvancedSignatureUseCase } from './get-public-advanced-signature.use-case';
import { LinkDocumentCollaboratorUseCase } from './link-document-collaborator.use-case';
import { UpdateDocumentUseCase } from './update-document.use-case';
import { DeleteDocumentUseCase } from './delete-document.use-case';
import { SubmitDocumentForAuthorizationUseCase } from './submit-document-for-authorization.use-case';
import { GetDocumentFileUrlUseCase } from './get-document-file-url.use-case';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => data),
    // { affected: 1 } por defecto: simula un UPDATE condicional exitoso (ver el claim atómico
    // en sign()/reject()/confirmCancellation()) — los tests que quieren simular una carrera
    // perdida sobreescriben esto explícitamente con { affected: 0 }.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

/**
 * Firmante que sí puede firmar: su credencial está en CONFIGURED, que es lo único que la firma
 * Simple exige (ver `assertCanSignWithSimpleSignature`). Las pruebas que quieren el caso
 * contrario pasan `signingCredentialStatus` en `overrides`.
 */
function buildSigner(
  overrides: Partial<CollaboratorEntity> & {
    userId?: string;
    signingCredentialStatus?: SIGNING_CREDENTIAL_STATUS_ENUM;
  } = {},
) {
  const userId = overrides.userId ?? 'user-1';
  const {
    userId: _omit,
    signingCredentialStatus = SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
    ...entityOverrides
  } = overrides;
  return {
    id: overrides.id ?? 'collaborator-1',
    documentId: 'doc-1',
    accountId: `account-of-${userId}`,
    email: null,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: overrides.signingOrder ?? 0,
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
        signingCredentialStatus,
      },
    },
    ...entityOverrides,
  } as unknown as CollaboratorEntity;
}

/**
 * Ubicación válida por defecto para las pruebas de firma. La geolocalización es obligatoria para
 * firmar, así que toda llamada a `sign()` que espere completarse debe incluirla.
 */
const TEST_GEOLOCATION = {
  latitude: 19.4326,
  longitude: -99.1332,
  accuracy: 15,
};

describe('casos de uso de documentos', () => {
  let service: DocumentService;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let userService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let signatureService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;
  let accountMemberService: Record<string, jest.Mock>;
  let verificationCodeService: Record<string, jest.Mock>;
  let documentTransactionService: Record<string, jest.Mock>;
  let efirmaService: Record<string, jest.Mock>;
  let sealDocumentUseCase: Record<string, jest.Mock>;
  let retryPendingSeal: { execute: jest.Mock };
  let sendCompletedSimpleSignatureToSeal: Record<string, jest.Mock>;
  let summaryDocumentService: Record<string, jest.Mock>;
  let advancedSummaryDocumentService: Record<string, jest.Mock>;
  let signatureQrService: Record<string, jest.Mock>;
  let createDocument: CreateDocumentUseCase;
  let getDocuments: GetDocumentsUseCase;
  let getDocument: GetDocumentUseCase;
  let signDocument: SignDocumentUseCase;
  let rejectDocument: RejectDocumentUseCase;
  let requestDocumentVerificationCode: RequestDocumentVerificationCodeUseCase;
  let verifyDocumentCode: VerifyDocumentCodeUseCase;
  let submitForCancellation: SubmitDocumentForCancellationUseCase;
  let confirmCancellation: ConfirmDocumentCancellationUseCase;
  let getPublicDocument: GetPublicDocumentUseCase;
  let getPublicSealArtifact: GetPublicSealArtifactUseCase;
  let getPublicAdvancedSignature: GetPublicAdvancedSignatureUseCase;
  let linkDocumentCollaborator: LinkDocumentCollaboratorUseCase;
  let updateDocument: UpdateDocumentUseCase;
  let deleteDocument: DeleteDocumentUseCase;
  let submitForAuthorization: SubmitDocumentForAuthorizationUseCase;
  let getDocumentFileUrl: GetDocumentFileUrlUseCase;

  beforeEach(async () => {
    documentRepository = createMockRepository();
    collaboratorRepository = createMockRepository();
    minioService = {
      uploadObject: jest.fn().mockResolvedValue({
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: 'object-key-1',
      }),
      getFile: jest.fn().mockResolvedValue({
        secureUrl: 'https://minio/file',
        expiresIn: 3600,
      }),
      getFileInBytesFormat: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      uploadPdfAObject: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn(),
      replaceFile: jest.fn(),
    };
    hashService = {
      generateFileHash: jest.fn().mockResolvedValue('hash123'),
      // Alimenta el campo "Cifrado" de la hoja de información de firmas.
      generateCiperHash: jest.fn().mockResolvedValue('cifrado-reversible'),
    };
    userService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'creator-1',
        firstName: 'Creador',
        lastName: 'Uno',
        email: 'creador@correo.com',
      }),
    };
    documentSigningService = {
      getPdfPages: jest.fn().mockResolvedValue(3),
      mergeSignatureIntoPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampRejectedWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampCancelledWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      appendPdfPages: jest
        .fn()
        .mockResolvedValue(Buffer.from('pdf-con-hoja-anexada')),
      // Página de prueba fija de 600x800pt — suficiente para verificar que la conversión
      // ratio→puntos y el pageIndex correcto llegan a mergeSignatureIntoPdf sin necesitar un
      // PDF real (eso ya lo cubre document-signing.service.spec.ts).
      resolveRatioPosition: jest.fn(async (_buffer: Buffer, position: any) => ({
        pageIndex: position.page - 1,
        coordinates: {
          x: position.xRatio * 600,
          y: 800 - (position.yRatio + position.heightRatio) * 800,
          width: position.widthRatio * 600,
          height: position.heightRatio * 800,
        },
      })),
    };
    signatureService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'signature-1',
        isActive: true,
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
      }),
    };
    emailService = {
      sendDocumentPendingNotification: jest.fn(),
      sendDocumentSignedNotification: jest.fn(),
      sendDocumentCompletedToCreatorNotification: jest.fn(),
      sendDocumentRejectedNotification: jest.fn(),
      sendDocumentCancellationPendingNotification: jest.fn(),
      sendDocumentCancelledNotification: jest.fn(),
      sendVerificationCodeNotification: jest.fn(),
    };
    auditService = { create: jest.fn() };
    documentEventsProducer = {
      emitCreated: jest.fn(),
      emitSentToSign: jest.fn(),
      emitCollaboratorSigned: jest.fn(),
      emitSigned: jest.fn(),
      emitRejected: jest.fn(),
      emitCancellationRequested: jest.fn(),
      emitCancelled: jest.fn(),
    };
    accountMemberService = {
      assertIsActiveMember: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', organizationId: null }),
      findPersonalAccountId: jest
        .fn()
        .mockImplementation((userId: string) =>
          Promise.resolve(`account-of-${userId}`),
        ),
    };
    verificationCodeService = {
      issue: jest.fn(),
      verifyAndConsume: jest.fn(),
      hasConsumedCode: jest.fn().mockResolvedValue(true),
      findConsumedCode: jest.fn().mockResolvedValue(null),
    };
    documentTransactionService = {
      createInitial: jest.fn(),
      registerSignature: jest.fn(),
      findAllForDocument: jest.fn().mockResolvedValue([]),
    };
    // Forma REAL de `SignatureResult` (ver src/efirma/interfaces): este mock devolvía un objeto
    // con las llaves en español (firmaBase64/certificado/...) que `EfirmaService.firmar` no
    // produce, así que los tests pasaban contra un contrato inexistente — y lo que se persiste en
    // `advancedSignature` es justo lo que después se le manda a Seal Service.
    efirmaService = {
      firmar: jest.fn().mockReturnValue({
        originalHash: 'hash-doc-1',
        signatureBase64: 'firma-base64',
        algorithm: 'sha256',
        signedAt: new Date('2026-01-01T00:00:00.000Z'),
        certificate: {
          rfc: 'XAXX010101000',
          name: 'Firmante Uno',
          issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
          serialNumber: '00001000000512345678',
          certificateNumber: '30001000000400002434',
          certificatePem: '-----BEGIN CERTIFICATE-----...',
        },
        // Evidencia de la consulta OCSP al SAT (`OscpService`): forma parte del payload de
        // sellado, así que sin ella la firma se registra pero el sellado nunca sale.
        ocspEvidence: {
          status: 'good',
          verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          ocspResponse: 'respuesta-ocsp-en-base64',
          ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
        },
      }),
    };
    sealDocumentUseCase = {
      create: jest.fn().mockResolvedValue({ id: 'seal-1' }),
      findByDocumentId: jest.fn().mockResolvedValue(null),
      persistIntegrityCertificateInfo: jest.fn().mockResolvedValue(undefined),
    };
    retryPendingSeal = { execute: jest.fn().mockResolvedValue(false) };
    // Devuelve `false` —"este documento no es asunto suyo"— salvo en las pruebas que lo miran.
    sendCompletedSimpleSignatureToSeal = {
      execute: jest.fn().mockResolvedValue(false),
    };
    summaryDocumentService = {
      generateSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas')),
    };
    advancedSummaryDocumentService = {
      generateAdvancedSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas-avanzada')),
    };
    signatureQrService = {
      generateAdvancedSignaturePng: jest
        .fn()
        .mockResolvedValue(Buffer.from('qr-png')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        CreateDocumentUseCase,
        GetDocumentsUseCase,
        GetDocumentUseCase,
        SignDocumentUseCase,
        RejectDocumentUseCase,
        RequestDocumentVerificationCodeUseCase,
        VerifyDocumentCodeUseCase,
        SubmitDocumentForCancellationUseCase,
        ConfirmDocumentCancellationUseCase,
        GetPublicDocumentUseCase,
        GetPublicSealArtifactUseCase,
        GetPublicAdvancedSignatureUseCase,
        LinkDocumentCollaboratorUseCase,
        UpdateDocumentUseCase,
        DeleteDocumentUseCase,
        SubmitDocumentForAuthorizationUseCase,
        GetDocumentFileUrlUseCase,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        { provide: MinioService, useValue: minioService },
        { provide: HashService, useValue: hashService },
        { provide: UserService, useValue: userService },
        { provide: PdfSignatureService, useValue: documentSigningService },
        { provide: SignatureService, useValue: signatureService },
        { provide: EmailService, useValue: emailService },
        { provide: AuditService, useValue: auditService },
        { provide: DocumentEventsProducer, useValue: documentEventsProducer },
        { provide: AccountMemberService, useValue: accountMemberService },
        {
          provide: VerificationCodeService,
          useValue: verificationCodeService,
        },
        {
          provide: DocumentTransactionService,
          useValue: documentTransactionService,
        },
        { provide: EfirmaService, useValue: efirmaService },
        { provide: SealDocumentUseCase, useValue: sealDocumentUseCase },
        /**
         * Reintento del sellado pendiente: por defecto no hay nada que reintentar (`false`), que
         * es el caso de todos estos escenarios. Las pruebas que sí lo ejercitan lo sobrescriben.
         */
        {
          provide: RetryPendingSealUseCase,
          useValue: retryPendingSeal,
        },
        {
          provide: SendCompletedSimpleSignatureToSealUseCase,
          useValue: sendCompletedSimpleSignatureToSeal,
        },
        {
          provide: SummaryDocumentService,
          useValue: summaryDocumentService,
        },
        {
          provide: AdvancedSummaryDocumentService,
          useValue: advancedSummaryDocumentService,
        },
        { provide: SignatureQrService, useValue: signatureQrService },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
    createDocument = module.get(CreateDocumentUseCase);
    getDocuments = module.get(GetDocumentsUseCase);
    getDocument = module.get(GetDocumentUseCase);
    signDocument = module.get(SignDocumentUseCase);
    rejectDocument = module.get(RejectDocumentUseCase);
    requestDocumentVerificationCode = module.get(
      RequestDocumentVerificationCodeUseCase,
    );
    verifyDocumentCode = module.get(VerifyDocumentCodeUseCase);
    submitForCancellation = module.get(SubmitDocumentForCancellationUseCase);
    confirmCancellation = module.get(ConfirmDocumentCancellationUseCase);
    getPublicDocument = module.get(GetPublicDocumentUseCase);
    getPublicSealArtifact = module.get(GetPublicSealArtifactUseCase);
    getPublicAdvancedSignature = module.get(GetPublicAdvancedSignatureUseCase);
    linkDocumentCollaborator = module.get(LinkDocumentCollaboratorUseCase);
    updateDocument = module.get(UpdateDocumentUseCase);
    deleteDocument = module.get(DeleteDocumentUseCase);
    submitForAuthorization = module.get(SubmitDocumentForAuthorizationUseCase);
    getDocumentFileUrl = module.get(GetDocumentFileUrlUseCase);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const file = {
      originalname: 'contrato.pdf',
      mimetype: 'application/pdf',
    } as Express.Multer.File;

    const dto = { signerIds: ['user-1'], watcherIds: [] } as any;

    beforeEach(() => {
      // findOne se usa para dos cosas distintas en create(): el chequeo de nombre
      // duplicado (where.fileName) y, más adelante, getDocumentMinioURL (where.id).
      // Se distinguen por la forma del query en vez de por orden de invocación.
      documentRepository.findOne.mockImplementation(async (options: any) => {
        if (options?.where?.fileName) return null;
        return {
          id: 'doc-1',
          status: DOCUMENT_STATUS_ENUM.CREATED,
          objectKey: 'object-key-1',
        };
      });
      documentRepository.save.mockImplementation(async (data) => ({
        id: 'doc-1',
        ...data,
      }));
      collaboratorRepository.find.mockResolvedValue([
        {
          ...buildSigner(),
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      ]);
    });

    it('crea el documento y sus colaboradores cuando todo es válido', async () => {
      const result = await createDocument.execute(
        'creator-1',
        'account-1',
        dto,
        file,
        '127.0.0.1',
      );

      expect(result.success).toBe(true);
      expect(minioService.uploadObject).toHaveBeenCalled();
      expect(collaboratorRepository.save).toHaveBeenCalled();
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'DOCUMENT_CREATED' }),
      );
      expect(documentEventsProducer.emitCreated).toHaveBeenCalled();
      expect(accountMemberService.assertIsActiveMember).toHaveBeenCalledWith(
        'creator-1',
        'account-1',
      );
      expect(documentTransactionService.createInitial).toHaveBeenCalledWith(
        'doc-1',
        'hash123',
      );

      const savedDocumentCall = documentRepository.save.mock.calls[0][0];
      expect(savedDocumentCall.accountId).toBe('account-1');
    });

    it('lanza BadRequestException si el PDF excede el límite de tamaño', async () => {
      const oversizedFile = {
        ...file,
        size: MAX_PDF_FILE_SIZE_BYTES + 1,
      } as Express.Multer.File;

      await expect(
        createDocument.execute(
          'creator-1',
          'account-1',
          dto,
          oversizedFile,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('setea totalSigners igual a la cantidad de firmantes seleccionados', async () => {
      const dtoConVariosFirmantes = {
        signerIds: ['user-1', 'user-2', 'user-3'],
        watcherIds: [],
      } as any;

      await createDocument.execute(
        'creator-1',
        'account-1',
        dtoConVariosFirmantes,
        file,
        '127.0.0.1',
      );

      const savedDocumentCall = documentRepository.save.mock.calls[0][0];
      expect(savedDocumentCall.totalSigners).toBe(3);
    });

    it('crea colaboradores WATCHER solo-por-email sin llamar a userService.findOne para ellos', async () => {
      const dtoConWatcherPorEmail = {
        signerIds: ['user-1'],
        watcherEmails: ['invitado@correo.com'],
      } as any;

      await createDocument.execute(
        'creator-1',
        'account-1',
        dtoConWatcherPorEmail,
        file,
        '127.0.0.1',
      );

      expect(userService.findOne).not.toHaveBeenCalledWith(
        'invitado@correo.com',
      );
      const savedCollaborators = collaboratorRepository.save.mock.calls[0][0];
      const watcherByEmail = savedCollaborators.find(
        (c: any) => c.email === 'invitado@correo.com',
      );
      expect(watcherByEmail).toMatchObject({
        colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
      });
      expect(watcherByEmail.accountId).toBeUndefined();
    });

    it('rechaza con BadRequestException si falta el header X-Account-Id', async () => {
      await expect(
        createDocument.execute(
          'creator-1',
          undefined as any,
          dto,
          file,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza con ForbiddenException si el creador no pertenece a la cuenta activa', async () => {
      accountMemberService.assertIsActiveMember.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(
        createDocument.execute(
          'creator-1',
          'account-ajena',
          dto,
          file,
          '127.0.0.1',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si no se proporciona archivo', async () => {
      await expect(
        createDocument.execute(
          'creator-1',
          'account-1',
          dto,
          undefined as any,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el mismo usuario está entre firmantes y watchers', async () => {
      const dupDto = { signerIds: ['user-1'], watcherIds: ['user-1'] } as any;

      await expect(
        createDocument.execute(
          'creator-1',
          'account-1',
          dupDto,
          file,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si el mismo email se repite entre watchers y reviewers', async () => {
      const dupDto = {
        signerIds: ['user-1'],
        watcherEmails: ['x@correo.com'],
        reviewerEmails: ['x@correo.com'],
      } as any;

      await expect(
        createDocument.execute(
          'creator-1',
          'account-1',
          dupDto,
          file,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si ya existe un documento propio con el mismo nombre en CREATED/PENDING', async () => {
      documentRepository.findOne.mockImplementation(async (options: any) => {
        if (options?.where?.fileName) return { id: 'existing-doc' };
        return null;
      });

      await expect(
        createDocument.execute(
          'creator-1',
          'account-1',
          dto,
          file,
          '127.0.0.1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });
  });

  describe('findWithFilters', () => {
    function createMockQueryBuilder(documents: unknown[] = [], total = 0) {
      const qb: any = {};
      [
        'where',
        'andWhere',
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
      ].forEach((method) => {
        qb[method] = jest.fn().mockReturnValue(qb);
      });
      qb.getManyAndCount = jest.fn().mockResolvedValue([documents, total]);
      return qb;
    }

    const query = { page: 1, limit: 10 } as any;

    it('rechaza con BadRequestException si falta el header X-Account-Id', async () => {
      await expect(
        getDocuments.execute('user-1', undefined as any, query),
      ).rejects.toThrow(BadRequestException);
      expect(documentRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rechaza con ForbiddenException si el usuario no pertenece a la cuenta activa', async () => {
      accountMemberService.assertIsActiveMember.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(
        getDocuments.execute('user-1', 'account-ajena', query),
      ).rejects.toThrow(ForbiddenException);
    });

    it('filtra el listado por accountId cuando la cuenta activa es PERSONAL', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', query);

      expect(accountMemberService.assertIsActiveMember).toHaveBeenCalledWith(
        'user-1',
        'account-1',
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'document.accountId = :accountId',
        { accountId: 'account-1' },
      );
    });

    it('filtra el listado por organizationId cuando la cuenta activa es de una organización (Fase 5)', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-org-member-1',
        organizationId: 'org-1',
      });

      await getDocuments.execute('user-1', 'account-org-member-1', query);

      expect(qb.andWhere).toHaveBeenCalledWith(
        'document.organizationId = :organizationId',
        { organizationId: 'org-1' },
      );
    });

    it('bug corregido: NO filtra por accountId/organizationId cuando se pide por participantEmail — un documento donde soy firmante casi siempre pertenece a la cuenta de quien lo creó, no a la mía', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', {
        ...query,
        participantEmail: 'firmante@correo.com',
      } as any);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'document.accountId = :accountId',
        expect.anything(),
      );
    });

    /**
     * Bug corregido ("las solicitudes FIEL sin 2FA no se muestran en Por firmar"): el listado
     * comparaba `collaborators.email` con `=` exacto contra el correo (ya en minúsculas) del
     * usuario en sesión, mientras que el detalle, la vinculación de cuenta y sign()/reject()
     * comparan sin distinguir mayúsculas. Un firmante invitado como "Juan.Perez@mail.com" no
     * veía el documento en "Por firmar" mientras su fila siguiera sin `accountId` — y sin 2FA
     * nada la vincula antes de firmar (con 2FA, pedir el código sí lo hace).
     */
    it('empareja al participante sin distinguir mayúsculas (firmante invitado con el correo en mayúsculas)', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', {
        ...query,
        participantEmail: 'Juan.Perez@Mail.com',
      } as any);

      const participantClause = qb.andWhere.mock.calls.find(([sql]: [string]) =>
        sql.includes('SELECT c.document_id'),
      );

      expect(participantClause).toBeDefined();
      expect(participantClause[0]).toContain('LOWER(c.email)');
      expect(participantClause[0]).toContain('LOWER(u.email)');
      expect(participantClause[1]).toEqual({
        participantEmail: 'juan.perez@mail.com',
      });
    });

    it('aplica el mismo emparejamiento insensible a mayúsculas en el filtro "me toca firmar"', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', {
        ...query,
        participantEmail: 'Juan.Perez@Mail.com',
        myTurnOnly: true,
      } as any);

      const myTurnClause = qb.andWhere.mock.calls.find(([sql]: [string]) =>
        sql.includes("c.colaborator_type = 'signer'"),
      );

      expect(myTurnClause).toBeDefined();
      expect(myTurnClause[0]).toContain('LOWER(c.email)');
      expect(myTurnClause[1]).toEqual({
        participantEmail: 'juan.perez@mail.com',
      });
    });

    it('empareja al creador sin distinguir mayúsculas (filtro `email`, "Enviados para firma")', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', {
        ...query,
        email: 'Creador@Mail.com',
      } as any);

      const creatorClause = qb.andWhere.mock.calls.find(([sql]: [string]) =>
        sql.includes('requester.email'),
      );

      expect(creatorClause).toBeDefined();
      expect(creatorClause[0]).toContain('LOWER(requester.email)');
      expect(creatorClause[1]).toEqual({ email: 'creador@mail.com' });
    });

    /**
     * La columna "Creado por" de las tres secciones del módulo Documentos muestra el nombre del
     * creador y su RFC como texto secundario. El RFC no está en `users` sino en
     * `personal_information`, así que sin el join el campo llegaba siempre en null al frontend.
     */
    it('devuelve el RFC del creador (join a personal_information) junto al nombre en cada documento', async () => {
      const qb = createMockQueryBuilder(
        [
          {
            id: 'doc-1',
            fileName: 'contrato.pdf',
            fileType: 'application/pdf',
            totalPages: 3,
            status: DOCUMENT_STATUS_ENUM.SIGNED,
            createdAt: new Date('2026-03-15T23:55:00.000Z'),
            collaborators: [],
            requestedBy: {
              firstName: 'Sara',
              lastName: 'Ramírez',
              personalInformation: { rfc: 'SARA850315HN2' },
            },
          },
        ],
        1,
      );
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      const result = await getDocuments.execute('user-1', 'account-1', query);

      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        'requester.personalInformation',
        'requesterPersonalInfo',
      );
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          creator: 'Sara Ramírez',
          creatorRfc: 'SARA850315HN2',
        }),
      );
    });

    it('deja `creatorRfc` en null si el creador todavía no registró su RFC, sin romper el listado', async () => {
      const qb = createMockQueryBuilder(
        [
          {
            id: 'doc-1',
            fileName: 'contrato.pdf',
            fileType: 'application/pdf',
            totalPages: 3,
            status: DOCUMENT_STATUS_ENUM.PENDING,
            createdAt: new Date('2026-03-15T23:55:00.000Z'),
            collaborators: [],
            requestedBy: { firstName: 'Sara', lastName: 'Ramírez' },
          },
        ],
        1,
      );
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      const result = await getDocuments.execute('user-1', 'account-1', query);

      expect(result.data[0]).toEqual(
        expect.objectContaining({ creatorRfc: null }),
      );
    });

    /**
     * Historia "Mostrar tipo de firma en las tablas de documentos": el tipo no vive en el
     * documento sino en cada firmante, y el listado lo resuelve para la columna del frontend.
     */
    describe('tipo de firma del documento', () => {
      function listWithSigners(collaborators: unknown[]) {
        const qb = createMockQueryBuilder(
          [
            {
              id: 'doc-1',
              fileName: 'contrato.pdf',
              fileType: 'application/pdf',
              totalPages: 1,
              status: DOCUMENT_STATUS_ENUM.PENDING,
              createdAt: new Date('2026-03-15T23:55:00.000Z'),
              collaborators,
              requestedBy: { firstName: 'Sara', lastName: 'Ramírez' },
            },
          ],
          1,
        );
        documentRepository.createQueryBuilder.mockReturnValue(qb);
        accountMemberService.assertIsActiveMember.mockResolvedValue({
          id: 'account-1',
          organizationId: null,
        });

        return getDocuments.execute('user-1', 'account-1', query);
      }

      function signer(signatureType: SIGNATURE_TYPE_ENUM | null) {
        return {
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
          signatureType,
          signingOrder: 0,
        };
      }

      it('devuelve el tipo de firma que comparten los firmantes', async () => {
        const result = await listWithSigners([
          signer(SIGNATURE_TYPE_ENUM.FIEL),
          signer(SIGNATURE_TYPE_ENUM.FIEL),
        ]);

        expect(result.data[0]).toEqual(
          expect.objectContaining({ signatureType: SIGNATURE_TYPE_ENUM.FIEL }),
        );
      });

      it('ignora a los colaboradores que no firman', async () => {
        const result = await listWithSigners([
          signer(SIGNATURE_TYPE_ENUM.SIMPLE),
          {
            colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
            signatureType: null,
          },
        ]);

        expect(result.data[0]).toEqual(
          expect.objectContaining({
            signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
          }),
        );
      });

      // Documentos del endpoint antiguo (POST /document), que nunca asignó tipo de firma: null
      // explícito en vez de suponer uno — el frontend muestra un guion.
      it('devuelve null si los firmantes no tienen tipo de firma registrado', async () => {
        const result = await listWithSigners([signer(null)]);

        expect(result.data[0]).toEqual(
          expect.objectContaining({ signatureType: null }),
        );
      });

      it('devuelve null si un documento mezclara tipos de firma', async () => {
        const result = await listWithSigners([
          signer(SIGNATURE_TYPE_ENUM.SIMPLE),
          signer(SIGNATURE_TYPE_ENUM.FIEL),
        ]);

        expect(result.data[0]).toEqual(
          expect.objectContaining({ signatureType: null }),
        );
      });
    });
  });

  describe('sign', () => {
    function mockDocument(overrides: Partial<DocumentEntity> = {}) {
      return {
        id: 'doc-1',
        objectKey: 'object-key-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING,
        ipAddress: '127.0.0.1',
        signatureCoordinates: null,
        ...overrides,
      } as DocumentEntity;
    }

    it('registra la firma y notifica al siguiente firmante si quedan pendientes', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SIGNEE_STATUS_ENUM.SIGNED,
        }),
      );
      expect(documentEventsProducer.emitSigned).not.toHaveBeenCalled();
      expect(
        documentEventsProducer.emitCollaboratorSigned,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          collaboratorId: 'collaborator-1',
        }),
      );
      expect(emailService.sendDocumentPendingNotification).toHaveBeenCalled();
      expect(documentRepository.update).toHaveBeenCalledWith('doc-1', {
        completedSignersCount: 1,
      });
    });

    /**
     * Historia "Generar código QR para firmas avanzadas": la firma avanzada (e.firma) no produce
     * ninguna imagen —su evidencia es criptográfica— y hasta ahora el espacio reservado para ella
     * quedaba vacío en el documento. Ahora se estampa ahí un código QR que lleva a la constancia
     * de esa firma, cumpliendo la misma función que la rúbrica de una firma simple.
     */
    describe('código QR de la firma avanzada', () => {
      /** Credenciales de e.firma válidas para el mock de EfirmaService. */
      function efirmaInput() {
        const file = (originalname: string) =>
          ({
            originalname,
            size: 1024,
            buffer: Buffer.from('contenido'),
          }) as Express.Multer.File;
        return {
          password: 'clave-correcta',
          keyFile: file('llave.key'),
          cerFile: file('certificado.cer'),
        };
      }

      /** Firmante avanzado con una posición de firma colocada. */
      function buildAdvancedSigner(
        overrides: Partial<CollaboratorEntity> = {},
      ) {
        return buildSigner({
          userId: 'user-1',
          signingOrder: 0,
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          simpleSignature: {
            id: 'ss-1',
            signatureCoordinates: [
              {
                signatureId: 'sig-1',
                page: 1,
                xRatio: 0.1,
                yRatio: 0.2,
                widthRatio: 0.2,
                heightRatio: 0.08,
              },
            ],
          },
          ...overrides,
        } as Partial<CollaboratorEntity> & { userId?: string });
      }

      async function signAdvanced() {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signer = buildAdvancedSigner();
        collaboratorRepository.find
          .mockResolvedValueOnce([signer])
          .mockResolvedValueOnce([signer]);

        await signDocument.execute(
          'doc-1',
          'user-1',
          efirmaInput(),
          TEST_GEOLOCATION,
        );
        return { document, signer };
      }

      /**
       * Historia "Redirigir QR de firma avanzada a la vista pública y resaltar al firmante": el
       * código lleva la URL de la verificación pública del documento, con esta firma señalada, y
       * NADA más. Antes llevaba el nombre, el RFC, la IP y la fecha como texto, que quedaban
       * legibles para cualquiera que escaneara una copia impresa.
       */
      it('genera el QR con el enlace a la vista pública, señalando esa firma', async () => {
        const { signer } = await signAdvanced();

        expect(
          signatureQrService.generateAdvancedSignaturePng,
        ).toHaveBeenCalledTimes(1);
        const [data] =
          signatureQrService.generateAdvancedSignaturePng.mock.calls[0];

        expect(data.verificationUrl).toContain('/public/documents/doc-1');
        expect(data.verificationUrl).toContain(`firma=${signer.id}`);
      });

      /**
       * Se afirma la ausencia campo por campo porque reponerlos es un renglón, y este contenido
       * queda impreso dentro de un PDF que ya nadie revisa. La geolocalización sigue en la lista
       * por la historia "Ocultar geolocalización en hojas de firma y vistas públicas".
       */
      it('no manda al QR ningún dato del firmante', async () => {
        await signAdvanced();

        const [data] =
          signatureQrService.generateAdvancedSignaturePng.mock.calls[0];

        expect(Object.keys(data)).toEqual(['verificationUrl']);
        for (const campo of [
          'signerName',
          'rfc',
          'ipAddress',
          'signedAt',
          'geoLocation',
        ]) {
          expect(data).not.toHaveProperty(campo);
        }
      });

      // El QR ocupa el lugar que tenía asignado esa firma, igual que la rúbrica de una simple: es
      // el mismo `mergeSignatureIntoPdf` con las mismas coordenadas.
      it('lo estampa en la ubicación asignada a la firma', async () => {
        await signAdvanced();

        expect(
          documentSigningService.mergeSignatureIntoPdf,
        ).toHaveBeenCalledTimes(1);
        const [, stampedImage] =
          documentSigningService.mergeSignatureIntoPdf.mock.calls[0];
        expect(stampedImage).toEqual(Buffer.from('qr-png'));
      });

      /**
       * Criterio "el QR conserva una proporción cuadrada, sin estiramiento": la caja de firma es
       * apaisada (está pensada para una rúbrica), así que el QR se encaja dentro sin deformarse.
       */
      it('lo estampa sin deformarlo dentro de la caja de firma', async () => {
        await signAdvanced();

        const [, , , , options] =
          documentSigningService.mergeSignatureIntoPdf.mock.calls[0];
        expect(options).toEqual({ preserveAspectRatio: true });
      });

      // Criterio: "el QR no se genera ni se muestra mientras la firma avanzada esté pendiente".
      it('no genera QR para una firma avanzada que sigue pendiente', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signer = buildAdvancedSigner();
        const pendingSigner = buildAdvancedSigner({
          id: 'collaborator-2',
          signingOrder: 1,
        } as Partial<CollaboratorEntity>);
        collaboratorRepository.find
          .mockResolvedValueOnce([signer, pendingSigner])
          .mockResolvedValueOnce([signer, pendingSigner]);
        collaboratorRepository.findOne = jest
          .fn()
          .mockResolvedValue(pendingSigner);

        await signDocument.execute(
          'doc-1',
          'user-1',
          efirmaInput(),
          TEST_GEOLOCATION,
        );

        // Firmó uno de dos: se regenera la vista previa con el avance, así que sí se pide el QR
        // del que ya firmó — pero en ninguna de las dos pasadas el del que sigue pendiente.
        const urls =
          signatureQrService.generateAdvancedSignaturePng.mock.calls.map(
            (call) => (call[0] as { verificationUrl: string }).verificationUrl,
          );
        expect(urls.some((url) => url.includes('collaborator-2'))).toBe(false);
      });

      // La firma simple no debe verse afectada: sigue estampando la rúbrica del firmante y sin
      // pedirle ningún QR al servicio.
      it('no toca el flujo de la firma simple', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const simpleSigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find
          .mockResolvedValueOnce([simpleSigner])
          .mockResolvedValueOnce([simpleSigner]);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(
          signatureQrService.generateAdvancedSignaturePng,
        ).not.toHaveBeenCalled();
        expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalled();
      });
    });

    /**
     * Historia "Actualizar el previsualizador con el avance de firmas": antes las rúbricas solo
     * se dibujaban sobre el PDF cuando firmaba el ÚLTIMO participante, así que quien abría un
     * documento a medio firmar veía el original limpio. Ahora, tras cada firma que no cierra el
     * documento, se regenera una vista previa con las firmas registradas hasta ese momento.
     */
    describe('vista previa con el avance de firmas', () => {
      /** Firma `user-1` de dos firmantes, dejando a `user-2` pendiente. */
      async function signFirstOfTwo() {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
        const signerB = buildSigner({
          id: 'collaborator-2',
          userId: 'user-2',
          signingOrder: 1,
        });
        collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
        collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );
        return { document, signerA, signerB };
      }

      function previewUpload() {
        return minioService.uploadPdfAObject.mock.calls.find(
          (call) => call[1] === BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS,
        );
      }

      it('con firmantes pendientes, guarda la vista previa en su propio bucket', async () => {
        await signFirstOfTwo();

        const upload = previewUpload();
        expect(upload).toBeDefined();
        expect(upload![0].name).toBe('contrato.pdf');
        expect(upload![3]).toBe('object-key-1');
      });

      // Solo se estampa a quien ya firmó: el firmante pendiente debe seguir con su espacio vacío.
      it('estampa únicamente a los firmantes que ya firmaron', async () => {
        await signFirstOfTwo();

        expect(
          documentSigningService.mergeSignatureIntoPdf,
        ).toHaveBeenCalledTimes(1);
      });

      /**
       * La vista previa se reconstruye desde el ORIGINAL, no encima de la vista previa anterior:
       * estampar de forma incremental acumularía cada pasada y una firma repetida terminaría
       * dibujando dos veces sobre el mismo lugar.
       */
      it('parte siempre del documento original', async () => {
        await signFirstOfTwo();

        expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );
        expect(minioService.getFileInBytesFormat).not.toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS,
        );
      });

      // Es una copia de conveniencia: la firma ya quedó registrada y no debe perderse porque
      // MinIO falle al guardar una vista previa.
      it('si falla, no rompe la firma que ya se registró', async () => {
        minioService.uploadPdfAObject.mockRejectedValueOnce(
          new Error('MinIO caído'),
        );

        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
        const signerB = buildSigner({
          id: 'collaborator-2',
          userId: 'user-2',
          signingOrder: 1,
        });
        collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
        collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);

        const result = await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(result.success).toBe(true);
        expect(collaboratorRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: SIGNEE_STATUS_ENUM.SIGNED }),
        );
      });

      // Con el último firmante el documento pasa a SIGNED y lo que se sirve es la versión
      // definitiva: una vista previa ahí quedaría huérfana y desactualizada.
      it('no genera vista previa cuando firma el último participante', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find
          .mockResolvedValueOnce([onlySigner])
          .mockResolvedValueOnce([onlySigner]);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(previewUpload()).toBeUndefined();
      });
    });

    it('bug corregido: rechaza con BadRequestException si dos peticiones casi simultáneas firman lo mismo (carrera perdida)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find.mockResolvedValue([onlySigner]);
      collaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
      // No debe desperdiciarse ningún trabajo de MinIO/estampado en una carrera perdida.
      expect(minioService.uploadObject).not.toHaveBeenCalled();
      expect(
        documentSigningService.mergeSignatureIntoPdf,
      ).not.toHaveBeenCalled();
    });

    it('finaliza el documento (estampa y notifica a todos) cuando es el último firmante', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner]) // signerCollaborators en sign()
        .mockResolvedValueOnce([onlySigner]); // collaboratorRepository.find en sendCompletionEmails

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalled();
      expect(minioService.uploadPdfAObject).toHaveBeenCalled();
      expect(documentEventsProducer.emitSigned).toHaveBeenCalled();
      expect(emailService.sendDocumentSignedNotification).toHaveBeenCalled();
      expect(document.completedSignersCount).toBe(1);
    });

    /**
     * Historia "Enviar información de firmantes simples al Seal Service al completar un
     * documento": el envío se dispara al firmar el último firmante y NO antes, porque el DTO
     * describe el documento completo.
     */
    describe('envío de las firmas simples a Seal Service', () => {
      it('se dispara cuando firma el último firmante', async () => {
        documentRepository.findOne.mockResolvedValue(mockDocument());
        const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find
          .mockResolvedValueOnce([onlySigner])
          .mockResolvedValueOnce([onlySigner]);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(sendCompletedSimpleSignatureToSeal.execute).toHaveBeenCalledWith(
          'doc-1',
        );
      });

      it('no se dispara mientras queden firmas pendientes', async () => {
        documentRepository.findOne.mockResolvedValue(mockDocument());
        const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
        const signerB = buildSigner({
          id: 'collaborator-2',
          userId: 'user-2',
          signingOrder: 1,
        });
        collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
        collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(
          sendCompletedSimpleSignatureToSeal.execute,
        ).not.toHaveBeenCalled();
      });

      /**
       * Best-effort, igual que el sellado avanzado: a esta altura la firma ya está registrada y
       * el PDF ya está en su bucket. Un 500 dejaría al firmante creyendo que su firma no ocurrió,
       * y su reintento chocaría contra el claim atómico sin poder corregir nada.
       */
      it('un fallo del envío no invalida la firma ya registrada', async () => {
        documentRepository.findOne.mockResolvedValue(mockDocument());
        const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find
          .mockResolvedValueOnce([onlySigner])
          .mockResolvedValueOnce([onlySigner]);
        sendCompletedSimpleSignatureToSeal.execute.mockRejectedValue(
          new Error('Seal Service no disponible'),
        );

        const result = await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );

        expect(result.success).toBe(true);
        expect(documentEventsProducer.emitSigned).toHaveBeenCalled();
      });
    });

    /**
     * Historia "Anexar hoja existente de información de firmas al documento final": al completarse
     * la firma se anexa la hoja YA EXISTENTE (SummaryDocumentService) al documento firmado y esa
     * copia —la definitiva— se guarda en un bucket aparte.
     */
    describe('hoja de información de firmas anexada al documento final', () => {
      async function signLastSigner() {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find
          .mockResolvedValueOnce([onlySigner])
          .mockResolvedValueOnce([onlySigner]);

        await signDocument.execute(
          'doc-1',
          'user-1',
          undefined,
          TEST_GEOLOCATION,
        );
        return document;
      }

      function uploadTo(bucket: BUCKET_TYPES_ENUM) {
        return minioService.uploadPdfAObject.mock.calls.find(
          (call) => call[1] === bucket,
        );
      }

      it('anexa la hoja al documento firmado y guarda el resultado en el bucket de finalizados', async () => {
        const document = await signLastSigner();

        expect(summaryDocumentService.generateSummaryPdf).toHaveBeenCalledTimes(
          1,
        );
        expect(documentSigningService.appendPdfPages).toHaveBeenCalledWith(
          Buffer.from('pdf'), // documento firmado (estampado)
          Buffer.from('hoja-de-firmas'), // hoja existente, sin regenerar
        );

        const finalizedUpload = uploadTo(BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS);
        expect(finalizedUpload).toBeDefined();
        expect(finalizedUpload![0].file).toEqual(
          Buffer.from('pdf-con-hoja-anexada'),
        );
        // Misma object key que el resto de las versiones: lo que cambia es el bucket.
        expect(finalizedUpload![3]).toBe(document.objectKey);
      });

      it('el documento firmado sigue guardándose sin la hoja: es el insumo de signedHash', async () => {
        await signLastSigner();

        const signedUpload = uploadTo(BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS);
        expect(signedUpload).toBeDefined();
        expect(signedUpload![0].file).toEqual(Buffer.from('pdf'));
        // El hash se calcula sobre el documento firmado, NO sobre el que lleva la hoja anexada.
        expect(hashService.generateFileHash).toHaveBeenCalledWith(
          Buffer.from('pdf'),
        );
      });

      /**
       * Historia "Crear hoja de evidencia específica para firma avanzada": un documento firmado
       * con e.firma lleva su propia hoja, no la de firma simple.
       */
      describe('firma avanzada (e.firma)', () => {
        async function signAdvancedDocument() {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const signer = buildSigner({
            userId: 'user-1',
            signingOrder: 0,
            signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          });
          collaboratorRepository.find
            .mockResolvedValueOnce([signer])
            .mockResolvedValueOnce([signer]);

          const efirmaInput = {
            password: 'clave-correcta',
            keyFile: {
              originalname: 'llave.key',
              buffer: Buffer.from('llave'),
            } as Express.Multer.File,
            cerFile: {
              originalname: 'certificado.cer',
              buffer: Buffer.from('cert'),
            } as Express.Multer.File,
          };
          await signDocument.execute(
            'doc-1',
            'user-1',
            efirmaInput,
            TEST_GEOLOCATION,
          );
          return document;
        }

        it('anexa la hoja de evidencia avanzada y no la de firma simple', async () => {
          await signAdvancedDocument();

          expect(
            advancedSummaryDocumentService.generateAdvancedSummaryPdf,
          ).toHaveBeenCalledTimes(1);
          expect(
            summaryDocumentService.generateSummaryPdf,
          ).not.toHaveBeenCalled();
          expect(documentSigningService.appendPdfPages).toHaveBeenCalledWith(
            Buffer.from('pdf'),
            Buffer.from('hoja-de-firmas-avanzada'),
          );
        });

        it('toma el número de serie del certificado y la firma electrónica de advancedSignature', async () => {
          const document = await signAdvancedDocument();

          const [info, signers] =
            advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock
              .calls[0];
          expect(info).toEqual(
            expect.objectContaining({
              id: 'doc-1',
              hash: document.signedHash,
              totalPages: document.totalPages,
              createdBy: 'creador@correo.com',
            }),
          );
          expect(signers).toEqual([
            expect.objectContaining({
              // El nombre del certificado del SAT gana al del perfil.
              name: 'Firmante Uno',
              certificateSerialNumber: '00001000000512345678',
              electronicSignature: 'firma-base64',
              signedAt: new Date('2026-01-01T00:00:00.000Z'),
            }),
          ]);
        });

        // La hoja avanzada no imprime "Cifrado": es un campo de la hoja simple.
        it('no incluye el campo Cifrado', async () => {
          await signAdvancedDocument();

          const [info] =
            advancedSummaryDocumentService.generateAdvancedSummaryPdf.mock
              .calls[0];
          expect(info).not.toHaveProperty('cipher');
        });
      });

      it('la hoja se genera con el hash firmado, el total de páginas y los datos de cada firmante', async () => {
        const document = await signLastSigner();

        const [info, signers] =
          summaryDocumentService.generateSummaryPdf.mock.calls[0];
        expect(info).toEqual(
          expect.objectContaining({
            id: 'doc-1',
            documentName: document.fileName,
            hash: document.signedHash,
            totalPages: document.totalPages,
            createdBy: 'creador@correo.com',
            verificationUrl: expect.stringContaining('/public/documents/doc-1'),
          }),
        );
        // "Cifrado" y el RFC del firmante ya no se imprimen: la plantilla vigente no los
        // contempla (historia "Estructura y diseño de las hojas de firma"). El cifrado sigue
        // viviendo en el Audit Trail, que es su fuente de verdad.
        expect(info).not.toHaveProperty('cipher');
        expect(signers[0]).not.toHaveProperty('rfc');
        // La geolocalización tampoco: se registra al firmar pero dejó de imprimirse (historia
        // "Ocultar geolocalización en hojas de firma y vistas públicas").
        expect(signers[0]).not.toHaveProperty('geoLocation');
        expect(signers).toEqual([
          expect.objectContaining({
            name: 'Firmante Uno',
            ipAddress: '127.0.0.1',
          }),
        ]);
      });

      it('si no se puede armar la versión final, el documento no queda firmado y la firma puede reintentarse', async () => {
        documentSigningService.appendPdfPages.mockRejectedValue(
          new Error('PDF corrupto'),
        );
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find.mockResolvedValue([onlySigner]);

        await expect(
          signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
        ).rejects.toThrow(/estampando el documento/i);

        expect(document.status).toBe(DOCUMENT_STATUS_ENUM.PENDING);
        expect(uploadTo(BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS)).toBeUndefined();
      });

      it('el usuario descarga la versión finalizada, no la del bucket de firmados', async () => {
        documentRepository.findOne.mockResolvedValue(
          mockDocument({ status: DOCUMENT_STATUS_ENUM.SIGNED }),
        );

        await service.getDocumentMinioURL('doc-1');

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        );
      });

      it('el correo de finalización adjunta la versión definitiva, la misma que se ve en la plataforma', async () => {
        await signLastSigner();

        expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        );
      });
    });

    it('bug corregido: además de a los participantes, notifica por correo a quien creó el documento con la lista de firmantes, ya que el creador no siempre es también un participante', async () => {
      const document = mockDocument({ createdBy: 'creator-1' });
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(userService.findOne).toHaveBeenCalledWith('creator-1');
      expect(
        emailService.sendDocumentCompletedToCreatorNotification,
      ).toHaveBeenCalledWith(
        'creador@correo.com',
        'Creador Uno',
        document.fileName,
        [collaboratorDisplayName(onlySigner)],
        expect.anything(),
      );
    });

    it('guarda un snapshot inmutable de la firma al firmar (bug: firma en vivo podía cambiar después)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);

      await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
        'sig-key',
        expect.anything(),
      );
      expect(minioService.uploadObject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'signature-snapshot.png' }),
        expect.anything(),
      );
      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ signatureSnapshotObjectKey: 'object-key-1' }),
      );
    });

    it('al finalizar, usa el snapshot ya guardado de un firmante anterior en vez de su firma en vivo (bug crítico corregido)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      // signerA ya firmó antes (en otro momento) y su snapshot quedó guardado con una clave
      // distinta a la firma "en vivo" (sig-key) — si el usuario desactivó/reemplazó su firma
      // después de firmar, signatureService.findOne ya no reflejaría lo que realmente firmó.
      const signerA = buildSigner({
        userId: 'user-a',
        signingOrder: 0,
        status: SIGNEE_STATUS_ENUM.SIGNED,
        signatureSnapshotObjectKey: 'signerA-snapshot-key',
      } as any);
      const signerB = buildSigner({ userId: 'user-b', signingOrder: 1 });
      collaboratorRepository.find
        .mockResolvedValueOnce([signerA, signerB])
        .mockResolvedValueOnce([signerA, signerB]);

      await signDocument.execute(
        'doc-1',
        'user-b',
        undefined,
        TEST_GEOLOCATION,
      );

      // El PDF final debe estampar el snapshot ya guardado de signerA (tomado cuando signerA
      // realmente firmó), no volver a resolver su firma "en vivo" en este momento.
      expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
        'signerA-snapshot-key',
        expect.anything(),
      );
    });

    it('sin coordenadas explícitas, estampa en el ancla por defecto del documento (regresión del apilado automático)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { x: 50, y: 200, width: 100, height: 80 },
        undefined,
        // Una rúbrica sigue llenando su caja completa: el encaje sin deformar es solo del QR.
        { preserveAspectRatio: false },
      );
    });

    it('mezcla coordenadas explícitas y apiladas automáticamente sin colisionar (Fase 4)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const explicitCoords = { x: 10, y: 10, width: 50, height: 50 };
      const signerA = buildSigner({
        userId: 'user-a',
        signingOrder: 0,
        status: SIGNEE_STATUS_ENUM.SIGNED,
        // Shape legacy (pre-migración ArraySignatureCoordinates, ver historia "Ubicación de
        // firmas por usuario") — sin xRatio, así que finalizeSignedDocument lo trata tal cual,
        // en píxeles absolutos, sin conversión de ratios.
        simpleSignature: { id: 'ss-1', signatureCoordinates: [explicitCoords] },
      } as any);
      const signerB = buildSigner({ userId: 'user-b', signingOrder: 1 });
      collaboratorRepository.find
        .mockResolvedValueOnce([signerA, signerB])
        .mockResolvedValueOnce([signerA, signerB]);

      await signDocument.execute(
        'doc-1',
        'user-b',
        undefined,
        TEST_GEOLOCATION,
      );

      const calls = documentSigningService.mergeSignatureIntoPdf.mock.calls;
      expect(calls[0][2]).toEqual(explicitCoords);
      expect(calls[1][2]).toEqual({ x: 50, y: 200, width: 100, height: 80 });
    });

    it('historia "Ubicación de firmas por usuario": estampa cada posición del arreglo en su página correspondiente', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({
        userId: 'user-1',
        signingOrder: 0,
        simpleSignature: {
          id: 'ss-1',
          signatureCoordinates: [
            {
              signatureId: 'sig-1',
              page: 1,
              xRatio: 0.1,
              yRatio: 0.2,
              widthRatio: 0.2,
              heightRatio: 0.08,
            },
            {
              signatureId: 'sig-2',
              page: 3,
              xRatio: 0.5,
              yRatio: 0.5,
              widthRatio: 0.2,
              heightRatio: 0.08,
            },
          ],
        },
      } as any);
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(documentSigningService.resolveRatioPosition).toHaveBeenCalledTimes(
        2,
      );
      const mergeCalls =
        documentSigningService.mergeSignatureIntoPdf.mock.calls;
      expect(mergeCalls).toHaveLength(2);
      expect(mergeCalls[0][3]).toBe(0); // page 1 → pageIndex 0
      expect(mergeCalls[1][3]).toBe(2); // page 3 → pageIndex 2
    });

    it('historia "Eliminar nombre al estampar firma simple": el estampado es solo la imagen — ninguna otra operación de dibujo sobre el PDF', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      // Se afirma sobre TODAS las operaciones del servicio de firmado, no sobre la ausencia de
      // una en particular: así, si alguien reintroduce un estampado de texto (el nombre u otro
      // dato) con cualquier nombre de método, este test lo detecta. `appendPdfPages` sí se espera
      // aquí: como este firmante es el único, la firma completa el documento y dispara
      // `attachSignaturesSheet` (anexar la hoja de información de firmas) — no es un estampado de
      // texto sobre el PDF firmado, sino la concatenación de la hoja ya generada aparte.
      const invokedOperations = Object.entries(documentSigningService)
        .filter(([, mock]) => mock.mock.calls.length > 0)
        .map(([name]) => name)
        .sort();
      expect(invokedOperations).toEqual([
        'appendPdfPages',
        'mergeSignatureIntoPdf',
      ]);
      expect(
        documentSigningService.mergeSignatureIntoPdf,
      ).toHaveBeenCalledTimes(1);
    });

    it('historia "Ubicación de firmas por usuario": con signatures vacío, firma sin estampar nada visualmente', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({
        userId: 'user-1',
        signingOrder: 0,
        simpleSignature: { id: 'ss-1', signatureCoordinates: [] },
      } as any);
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(
        documentSigningService.mergeSignatureIntoPdf,
      ).not.toHaveBeenCalled();
      // Sigue subiendo el PDF (sin cambios visuales) y marcando el documento como firmado.
      expect(minioService.uploadPdfAObject).toHaveBeenCalled();
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
    });

    it('rechaza si el documento no está en estatus PENDING', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.CREATED }),
      );

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el usuario no es firmante del documento', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rechaza si el firmante ya respondió antes', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({
          userId: 'user-1',
          status: SIGNEE_STATUS_ENUM.SIGNED,
        }),
      ]);

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si aún no es el turno del firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ id: 'p-0', userId: 'user-0', signingOrder: 0 }),
        buildSigner({ id: 'p-1', userId: 'user-1', signingOrder: 1 }),
      ]);

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * La firma Simple se decide con una sola variable. Antes se cruzaban `signatureId`, la fila
     * de `signatures` y sus dos object keys, lo que dejaba pasar a un usuario con la rúbrica
     * subida pero con la verificación de identidad rechazada.
     */
    describe.each([
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_PROGRESS,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_REVIEW,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_FAILED,
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
    ])('credencial en %s', (signingCredentialStatus) => {
      it('no deja firmar con firma Simple', async () => {
        documentRepository.findOne.mockResolvedValue(mockDocument());
        collaboratorRepository.find.mockResolvedValue([
          buildSigner({ userId: 'user-1', signingCredentialStatus }),
        ]);

        await expect(
          signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
        ).rejects.toThrow(
          'Es necesario configurar tu identidad y firma para poder firmar con firma Simple.',
        );
      });

      /**
       * El rechazo se comprueba antes del claim atómico: si se hiciera después, el colaborador
       * quedaría marcado como SIGNED sin firma detrás y sin poder reintentar.
       */
      it('no reclama el turno ni toca el documento', async () => {
        documentRepository.findOne.mockResolvedValue(mockDocument());
        collaboratorRepository.find.mockResolvedValue([
          buildSigner({ userId: 'user-1', signingCredentialStatus }),
        ]);

        await expect(
          signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
        ).rejects.toThrow(BadRequestException);
        expect(collaboratorRepository.update).not.toHaveBeenCalled();
      });
    });

    /**
     * Firmar con e.firma acredita la identidad con el certificado del SAT, así que no depende de
     * la credencial de firma Simple: exigirla dejaría sin firmar a quien tiene su e.firma al día
     * pero nunca pasó por Didit.
     */
    it('la firma avanzada no exige la credencial de firma Simple', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({
          userId: 'user-1',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          signingCredentialStatus:
            SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
        } as never),
      ]);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        {
          password: 'clave-correcta',
          keyFile: {
            originalname: 'llave.key',
            buffer: Buffer.from('llave'),
          } as Express.Multer.File,
          cerFile: {
            originalname: 'certificado.cer',
            buffer: Buffer.from('cert'),
          } as Express.Multer.File,
        },
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
    });

    it('rechaza si el documento requiere verificación y el firmante no ha validado su código (Fase 7)', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ requiresVerification: true } as any),
      );
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      verificationCodeService.hasConsumedCode.mockResolvedValue(false);

      await expect(
        signDocument.execute('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
      expect(verificationCodeService.hasConsumedCode).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        'sign_document',
      );
    });

    it('permite firmar si el documento requiere verificación y el firmante ya validó su código', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ requiresVerification: true } as any),
      );
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(signerB);
      verificationCodeService.hasConsumedCode.mockResolvedValue(true);

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
    });

    it('Caso A ("Notificación por Email para Firma Simple y Vinculación de Cuenta"): si el usuario autenticado no aparece como firmante todavía, se vincula por email y firma en la misma petición', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      userService.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'maria@correo.com',
      });

      const linkedSigner = buildSigner({
        id: 'collaborator-1',
        userId: 'user-1',
        signingOrder: 0,
      });

      collaboratorRepository.find
        .mockResolvedValueOnce([]) // primer find en sign(): nadie coincide por accountId todavía
        .mockResolvedValueOnce([linkedSigner]); // segundo find, tras vincular por email
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'collaborator-1',
        email: 'maria@correo.com',
        accountId: null,
      });

      const result = await signDocument.execute(
        'doc-1',
        'user-1',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        'collaborator-1',
        { accountId: 'account-of-user-1' },
      );
    });

    it('con isSequential=false, un firmante que no es el primero en signingOrder puede firmar directamente (sin esperar turno)', async () => {
      const document = mockDocument({ isSequential: false } as any);
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-a', signingOrder: 0 }); // sigue PENDING
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-b',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

      const result = await signDocument.execute(
        'doc-1',
        'user-b',
        undefined,
        TEST_GEOLOCATION,
      );

      expect(result.success).toBe(true);
    });

    describe('firma electrónica avanzada (FIEL)', () => {
      function buildFielSigner(
        overrides: Partial<CollaboratorEntity> & { userId?: string } = {},
      ) {
        return buildSigner({
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          ...overrides,
        } as any);
      }

      function buildFile(
        overrides: Partial<Express.Multer.File> = {},
      ): Express.Multer.File {
        return {
          originalname: 'archivo.key',
          size: 1024,
          buffer: Buffer.from('contenido'),
          ...overrides,
        } as Express.Multer.File;
      }

      it('valida con EfirmaService y guarda el resultado no sensible en advancedSignature (sin estampar imagen)', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildFielSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find.mockResolvedValue([signerA]);

        const keyFile = buildFile({ originalname: 'llave.KEY' });
        const cerFile = buildFile({
          originalname: 'certificado.cer',
          buffer: Buffer.from('cert'),
        });

        const result = await signDocument.execute(
          'doc-1',
          'user-1',
          {
            password: 'clave-correcta',
            keyFile,
            cerFile,
          },
          TEST_GEOLOCATION,
        );

        expect(result.success).toBe(true);
        expect(efirmaService.firmar).toHaveBeenCalledWith(
          Buffer.from('pdf'), // documentBuffer mockeado por minioService.getFileInBytesFormat
          cerFile.buffer,
          keyFile.buffer,
          'clave-correcta',
        );
        expect(collaboratorRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            advancedSignature: expect.objectContaining({
              signatureBase64: 'firma-base64',
            }),
          }),
        );
        // No usa ninguna imagen de rúbrica: la firma FIEL no tiene snapshot. Desde la historia
        // "Generar código QR para firmas avanzadas" sí se estampa algo en su lugar —el código QR
        // de la firma— pero nunca una firma tomada del perfil del usuario.
        expect(signatureService.findOne).not.toHaveBeenCalled();
        expect(minioService.getFileInBytesFormat).not.toHaveBeenCalledWith(
          expect.anything(),
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );
      });

      describe('integración con Seal Service (historia "Completar flujo de firma avanzada")', () => {
        function signWithEfirma(userId: string) {
          return signDocument.execute(
            'doc-1',
            userId,
            {
              password: 'clave-correcta',
              keyFile: buildFile({ originalname: 'llave.key' }),
              cerFile: buildFile({ originalname: 'certificado.cer' }),
            },
            TEST_GEOLOCATION,
          );
        }

        it('al completarse el documento, manda el documentId y el arreglo con la información de cada firma', async () => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const onlySigner = buildFielSigner({
            userId: 'user-1',
            signingOrder: 0,
          });
          collaboratorRepository.find.mockResolvedValue([onlySigner]);

          await signWithEfirma('user-1');

          expect(sealDocumentUseCase.create).toHaveBeenCalledTimes(1);
          expect(sealDocumentUseCase.create).toHaveBeenCalledWith({
            documentId: 'doc-1',
            originalHash: document.originalHash,
            signatures: [
              {
                signatureBase64: 'firma-base64',
                algorithm: 'sha256',
                // Normalizado a ISO 8601: el proveedor ordena y canonicaliza por este valor.
                signedAt: '2026-01-01T00:00:00.000Z',
                certificate: {
                  rfc: 'XAXX010101000',
                  name: 'Firmante Uno',
                  issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
                  serialNumber: '00001000000512345678',
                  certificateNumber: '30001000000400002434',
                  certificatePem: '-----BEGIN CERTIFICATE-----...',
                },
                // También normalizada a ISO 8601, por el mismo motivo que `signedAt`.
                ocspEvidence: {
                  status: 'good',
                  verifiedAt: '2026-01-01T00:00:00.000Z',
                  ocspResponse: 'respuesta-ocsp-en-base64',
                  ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
                },
              },
            ],
          });
        });

        it('sella UNA sola vez, con las firmas de TODOS los firmantes, cuando termina el último', async () => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const signerA = buildFielSigner({
            id: 'p-a',
            userId: 'user-a',
            signingOrder: 0,
            status: SIGNEE_STATUS_ENUM.SIGNED,
            advancedSignature: {
              originalHash: 'hash-doc-1',
              signatureBase64: 'firma-de-a',
              algorithm: 'sha256',
              signedAt: '2026-01-01T00:00:00.000Z',
              certificate: {
                rfc: 'AAAA010101AAA',
                name: 'Firmante A',
                issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
                serialNumber: '1',
                certificateNumber: '2',
                certificatePem: 'pem-a',
              },
              // Releída de la columna jsonb: fechas como string, sin tipo fecha.
              ocspEvidence: {
                status: 'good',
                verifiedAt: '2026-01-01T00:00:00.000Z',
                ocspResponse: 'respuesta-ocsp-de-a',
                ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
              },
            },
          } as any);
          const signerB = buildFielSigner({
            id: 'p-b',
            userId: 'user-b',
            signingOrder: 1,
          });
          collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

          await signWithEfirma('user-b');

          expect(sealDocumentUseCase.create).toHaveBeenCalledTimes(1);
          const [payload] = sealDocumentUseCase.create.mock.calls[0];
          expect(payload.signatures).toHaveLength(2);
          expect(
            payload.signatures.map(
              (signature: { signatureBase64: string }) =>
                signature.signatureBase64,
            ),
          ).toEqual(['firma-de-a', 'firma-base64']);
        });

        it('no sella mientras queden firmantes pendientes: el hash canónico se calcula sobre el conjunto completo', async () => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const signerA = buildFielSigner({
            id: 'p-a',
            userId: 'user-a',
            signingOrder: 0,
          });
          const signerB = buildFielSigner({
            id: 'p-b',
            userId: 'user-b',
            signingOrder: 1,
          });
          collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

          await signWithEfirma('user-a');

          expect(sealDocumentUseCase.create).not.toHaveBeenCalled();
        });

        it('un documento de firma simple no se sella: no hay firma criptográfica que sellar', async () => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
          collaboratorRepository.find
            .mockResolvedValueOnce([onlySigner])
            .mockResolvedValueOnce([onlySigner]);

          await signDocument.execute(
            'doc-1',
            'user-1',
            undefined,
            TEST_GEOLOCATION,
          );

          expect(sealDocumentUseCase.create).not.toHaveBeenCalled();
        });

        it('si Seal Service falla, la firma igual queda registrada: el sellado es best-effort', async () => {
          sealDocumentUseCase.create.mockRejectedValue(
            new Error('Seal Service caído'),
          );
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const onlySigner = buildFielSigner({
            userId: 'user-1',
            signingOrder: 0,
          });
          collaboratorRepository.find.mockResolvedValue([onlySigner]);

          const result = await signWithEfirma('user-1');

          expect(result.success).toBe(true);
          expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
          expect(collaboratorRepository.save).toHaveBeenCalled();
          expect(documentEventsProducer.emitSigned).toHaveBeenCalled();
        });
      });

      it.each([
        ['keyFile', undefined, 'Falta el archivo de la llave privada (.key)'],
        ['cerFile', undefined, 'Falta el archivo del certificado (.cer)'],
      ])(
        'rechaza sin llamar a EfirmaService cuando falta %s',
        async (field, _value, expectedMessage) => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const signerA = buildFielSigner({
            userId: 'user-1',
            signingOrder: 0,
          });
          collaboratorRepository.find.mockResolvedValue([signerA]);

          const input: any = {
            password: 'clave',
            keyFile: buildFile(),
            cerFile: buildFile({ originalname: 'cert.cer' }),
          };
          delete input[field];

          await expect(
            signDocument.execute('doc-1', 'user-1', input, TEST_GEOLOCATION),
          ).rejects.toThrow(expectedMessage);
          expect(efirmaService.firmar).not.toHaveBeenCalled();
          // El claim atómico (que marca SIGNED) tampoco debe haber corrido.
          expect(collaboratorRepository.update).not.toHaveBeenCalled();
        },
      );

      it('rechaza sin llamar a EfirmaService cuando falta la contraseña', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildFielSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find.mockResolvedValue([signerA]);

        await expect(
          signDocument.execute(
            'doc-1',
            'user-1',
            {
              keyFile: buildFile(),
              cerFile: buildFile({ originalname: 'cert.cer' }),
            },
            TEST_GEOLOCATION,
          ),
        ).rejects.toThrow('Falta la contraseña de la llave privada');
        expect(efirmaService.firmar).not.toHaveBeenCalled();
      });

      it.each([
        ['keyFile', { originalname: 'llave.txt' }, '.key'],
        ['cerFile', { originalname: 'certificado.pdf' }, '.cer'],
      ])(
        'rechaza cuando %s tiene una extensión inválida',
        async (field, override, expectedExtension) => {
          const document = mockDocument();
          documentRepository.findOne.mockResolvedValue(document);
          const signerA = buildFielSigner({
            userId: 'user-1',
            signingOrder: 0,
          });
          collaboratorRepository.find.mockResolvedValue([signerA]);

          const input: any = {
            password: 'clave',
            keyFile: buildFile(),
            cerFile: buildFile({ originalname: 'cert.cer' }),
          };
          input[field] = buildFile(override);

          await expect(
            signDocument.execute('doc-1', 'user-1', input, TEST_GEOLOCATION),
          ).rejects.toThrow(expectedExtension);
          expect(efirmaService.firmar).not.toHaveBeenCalled();
        },
      );

      it('rechaza cuando el archivo .key excede el tamaño máximo permitido', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildFielSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find.mockResolvedValue([signerA]);

        await expect(
          signDocument.execute(
            'doc-1',
            'user-1',
            {
              password: 'clave',
              keyFile: buildFile({ size: 10 * 1024 * 1024 }),
              cerFile: buildFile({ originalname: 'cert.cer' }),
            },
            TEST_GEOLOCATION,
          ),
        ).rejects.toThrow('excede el tamaño máximo permitido');
        expect(efirmaService.firmar).not.toHaveBeenCalled();
      });

      it('propaga el error de EfirmaService (ej. contraseña incorrecta) sin marcar al colaborador como firmado', async () => {
        const document = mockDocument();
        documentRepository.findOne.mockResolvedValue(document);
        const signerA = buildFielSigner({ userId: 'user-1', signingOrder: 0 });
        collaboratorRepository.find.mockResolvedValue([signerA]);
        efirmaService.firmar.mockImplementation(() => {
          throw new UnprocessableEntityException(
            'No fue posible descifrar la llave privada (.key). verifica la constraseña.',
          );
        });

        await expect(
          signDocument.execute(
            'doc-1',
            'user-1',
            {
              password: 'clave-incorrecta',
              keyFile: buildFile(),
              cerFile: buildFile({ originalname: 'cert.cer' }),
            },
            TEST_GEOLOCATION,
          ),
        ).rejects.toThrow('verifica la constraseña');
        // La validación corre ANTES del claim atómico: nunca debe quedar marcado SIGNED.
        expect(collaboratorRepository.update).not.toHaveBeenCalled();
        expect(collaboratorRepository.save).not.toHaveBeenCalled();
      });
    });

    it('captura y persiste la geolocalización declarada por el dispositivo del firmante', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

      const geolocation = {
        latitude: 19.4326,
        longitude: -99.1332,
        accuracy: 15,
      };

      await signDocument.execute('doc-1', 'user-1', undefined, geolocation);

      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ geoLoc: geolocation }),
      );
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ geolocation }),
      );
    });

    /**
     * La geolocalización pasó de opcional a obligatoria: antes, firmar sin ella guardaba
     * `geoLoc: null` y la firma seguía adelante. Ahora se rechaza — la ubicación es parte no
     * negociable de la evidencia de firma.
     */
    it('rechaza firmar sin geolocalización y no registra ninguna firma', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

      await expect(signDocument.execute('doc-1', 'user-1')).rejects.toThrow(
        /geolocalización es obligatoria/i,
      );

      expect(collaboratorRepository.save).not.toHaveBeenCalled();
      expect(auditService.create).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    function mockDocument(overrides: Partial<DocumentEntity> = {}) {
      return {
        id: 'doc-1',
        objectKey: 'object-key-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING,
        ipAddress: '127.0.0.1',
        createdBy: 'creator-1',
        ...overrides,
      } as DocumentEntity;
    }

    /**
     * Rechazar no produce ninguna firma, así que no exige la credencial. Cuando sí la exigía,
     * un firmante sin identidad validada no podía firmar —correcto— pero tampoco declinar, y el
     * documento se quedaba esperando para siempre una respuesta que esa persona no podía dar.
     */
    it('deja rechazar aunque la credencial de firma no este configurada', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({
          userId: 'user-1',
          signingCredentialStatus:
            SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
        }),
      ]);

      const result = await rejectDocument.execute(
        'doc-1',
        'user-1',
        'No estoy de acuerdo',
      );

      expect(result.success).toBe(true);
      expect(collaboratorRepository.update).toHaveBeenCalled();
    });

    it('rechaza el documento, estampa marca de agua y notifica al creador', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      const result = await rejectDocument.execute(
        'doc-1',
        'user-1',
        'No es válido',
      );

      expect(result.success).toBe(true);
      expect(documentSigningService.stampRejectedWatermark).toHaveBeenCalled();
      expect(emailService.sendDocumentRejectedNotification).toHaveBeenCalled();
      expect(documentEventsProducer.emitRejected).toHaveBeenCalled();
    });

    it('rechaza con BadRequestException si el documento no está PENDING', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.SIGNED }),
      );

      await expect(
        rejectDocument.execute('doc-1', 'user-1', 'motivo'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza con ForbiddenException si el usuario no es firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        rejectDocument.execute('doc-1', 'user-1', 'motivo'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('bug corregido: rechaza con BadRequestException si dos peticiones casi simultáneas rechazan lo mismo (carrera perdida)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      collaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        rejectDocument.execute('doc-1', 'user-1', 'motivo'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
    });

    it('bug corregido: Caso A también aplica a reject() — si el usuario autenticado no aparece como firmante todavía, se vincula por email y puede rechazar en la misma petición', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      userService.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'maria@correo.com',
      });

      const linkedSigner = buildSigner({
        id: 'collaborator-1',
        userId: 'user-1',
        signingOrder: 0,
      });

      collaboratorRepository.find
        .mockResolvedValueOnce([]) // primer find en reject(): nadie coincide por accountId todavía
        .mockResolvedValueOnce([linkedSigner]); // segundo find, tras vincular por email
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'collaborator-1',
        email: 'maria@correo.com',
        accountId: null,
      });

      const result = await rejectDocument.execute(
        'doc-1',
        'user-1',
        'No es válido',
      );

      expect(result.success).toBe(true);
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        'collaborator-1',
        { accountId: 'account-of-user-1' },
      );
    });
  });

  describe('requestVerificationCode / verifyCode', () => {
    function mockDocument(overrides: Partial<DocumentEntity> = {}) {
      return {
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING,
        ...overrides,
      } as DocumentEntity;
    }

    it('requestVerificationCode emite y envía el código cuando el usuario ya es firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.findOne.mockResolvedValue(
        buildSigner({ userId: 'user-1' }),
      );
      verificationCodeService.issue.mockResolvedValue({ code: '123456' });

      const result = await requestDocumentVerificationCode.execute(
        'doc-1',
        'user-1',
        '127.0.0.1',
      );

      expect(result.success).toBe(true);
      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        'sign_document',
        '127.0.0.1',
      );
      expect(emailService.sendVerificationCodeNotification).toHaveBeenCalled();
    });

    it('bug corregido: si el envío del correo falla, el código sigue emitido y la petición NO revienta con 500 — se reporta emailDelivered:false para que la UI ofrezca el reenvío', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.findOne.mockResolvedValue(
        buildSigner({ userId: 'user-1' }),
      );
      verificationCodeService.issue.mockResolvedValue({ code: '123456' });
      emailService.sendVerificationCodeNotification.mockRejectedValue(
        new Error('Failed to send email'),
      );

      const result = await requestDocumentVerificationCode.execute(
        'doc-1',
        'user-1',
        '127.0.0.1',
      );

      expect(result.success).toBe(true);
      expect(result.data.emailDelivered).toBe(false);
      expect(result.message).toMatch(/no se pudo enviar el correo/i);
      // El código sí quedó emitido: el firmante puede validarlo por el reenvío o por soporte.
      expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
    });

    it('cuando el correo sí sale, lo reporta con emailDelivered:true', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.findOne.mockResolvedValue(
        buildSigner({ userId: 'user-1' }),
      );
      verificationCodeService.issue.mockResolvedValue({ code: '123456' });

      const result = await requestDocumentVerificationCode.execute(
        'doc-1',
        'user-1',
        '127.0.0.1',
      );

      expect(result.data.emailDelivered).toBe(true);
    });

    it('bug corregido: Caso A también aplica a requestVerificationCode — si el usuario autenticado no aparece como firmante todavía, se vincula por email antes de emitir el código (Firma Simple exige 2FA ANTES de firmar, así que sin esto el firmante nunca llegaba a sign() para que la vinculación perezosa de ahí lo rescatara)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      userService.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'maria@correo.com',
      });
      const linkedSigner = buildSigner({
        id: 'collaborator-1',
        userId: 'user-1',
      });
      collaboratorRepository.findOne
        .mockResolvedValueOnce(null) // primer intento: nadie coincide por accountId todavía
        .mockResolvedValueOnce({
          id: 'collaborator-1',
          email: 'maria@correo.com',
          accountId: null,
        }) // usado por linkPendingCollaboratorAccount para encontrar la invitación pendiente
        .mockResolvedValueOnce(linkedSigner); // segundo intento, tras vincular por email
      verificationCodeService.issue.mockResolvedValue({ code: '123456' });

      const result = await requestDocumentVerificationCode.execute(
        'doc-1',
        'user-1',
        '127.0.0.1',
      );

      expect(result.success).toBe(true);
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        'collaborator-1',
        { accountId: 'account-of-user-1' },
      );
      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        'sign_document',
        '127.0.0.1',
      );
    });

    it('requestVerificationCode rechaza con ForbiddenException si el email no coincide con ninguna invitación pendiente', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      userService.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'nadie@correo.com',
      });
      collaboratorRepository.findOne.mockResolvedValue(null);

      await expect(
        requestDocumentVerificationCode.execute('doc-1', 'user-1', '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('verifyCode consume el código cuando el usuario ya es firmante', async () => {
      collaboratorRepository.findOne.mockResolvedValue(
        buildSigner({ userId: 'user-1' }),
      );

      const result = await verifyDocumentCode.execute(
        'doc-1',
        'user-1',
        '123456',
      );

      expect(result.success).toBe(true);
      expect(verificationCodeService.verifyAndConsume).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        '123456',
      );
    });

    it('verifyCode también aplica el Caso A (vinculación perezosa por email)', async () => {
      userService.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'maria@correo.com',
      });
      const linkedSigner = buildSigner({
        id: 'collaborator-1',
        userId: 'user-1',
      });
      collaboratorRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'collaborator-1',
          email: 'maria@correo.com',
          accountId: null,
        })
        .mockResolvedValueOnce(linkedSigner);

      const result = await verifyDocumentCode.execute(
        'doc-1',
        'user-1',
        '123456',
      );

      expect(result.success).toBe(true);
      expect(verificationCodeService.verifyAndConsume).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        '123456',
      );
    });
  });

  describe('requestCancellation', () => {
    function mockDocument(overrides: Partial<DocumentEntity> = {}) {
      return {
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        createdBy: 'creator-1',
        ...overrides,
      } as DocumentEntity;
    }

    it('pasa el documento a CANCELLATION_PENDING y notifica a los firmantes', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      const result = await submitForCancellation.execute('doc-1', 'creator-1');

      expect(result.success).toBe(true);
      expect(documentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
        }),
      );
      expect(
        emailService.sendDocumentCancellationPendingNotification,
      ).toHaveBeenCalled();
    });

    it('registra auditoría y emite evento Kafka (gap cerrado en la Fase 6)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      await submitForCancellation.execute('doc-1', 'creator-1');

      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'DOCUMENT_CANCELLATION_REQUESTED',
          documentId: 'doc-1',
        }),
      );
      expect(
        documentEventsProducer.emitCancellationRequested,
      ).toHaveBeenCalledWith({
        documentId: 'doc-1',
        fileName: 'contrato.pdf',
        actorUserId: 'creator-1',
      });
    });

    it('rechaza con ForbiddenException si quien solicita no es el creador', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());

      await expect(
        submitForCancellation.execute('doc-1', 'otro-usuario'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rechaza con BadRequestException si el documento no está SIGNED', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.PENDING }),
      );

      await expect(
        submitForCancellation.execute('doc-1', 'creator-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('confirmCancellation', () => {
    function mockDocument(overrides: Partial<DocumentEntity> = {}) {
      return {
        id: 'doc-1',
        objectKey: 'object-key-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
        createdBy: 'creator-1',
        ...overrides,
      } as DocumentEntity;
    }

    it('cancela el documento cuando lo confirma un firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      const result = await confirmCancellation.execute('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(documentSigningService.stampCancelledWatermark).toHaveBeenCalled();
      expect(documentRepository.update).toHaveBeenCalledWith(
        { id: 'doc-1', status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING },
        expect.objectContaining({ status: DOCUMENT_STATUS_ENUM.CANCELLED }),
      );
      expect(documentEventsProducer.emitCancelled).toHaveBeenCalled();
    });

    it('rechaza con BadRequestException si el documento no está en CANCELLATION_PENDING', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.SIGNED }),
      );

      await expect(
        confirmCancellation.execute('doc-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza con ForbiddenException si quien confirma no es firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        confirmCancellation.execute('doc-1', 'user-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('bug corregido: rechaza con BadRequestException si dos firmantes confirman casi simultáneamente (carrera perdida)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      documentRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        confirmCancellation.execute('doc-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
    });
  });

  describe('getPublicDocumentView', () => {
    /** Sello persistido completo — el que produce un documento de firma avanzada ya sellado. */
    const SEAL = {
      id: 'seal-1',
      documentId: 'doc-1',
      signatureHash: 'hash-sellado',
      canonicalPayload: 'v1||12:hola-mundo',
      sealedAt: new Date('2026-08-14T18:24:11.000Z'),
      timestampEvidence: {
        isValid: true,
        processedHash: 'hash-ts',
        fileBase64: 'dG9rZW4tdHM=',
        evidenceId: 'ts-1',
        issuedAt: new Date('2026-08-14T18:24:11.000Z'),
      },
      integrityEvidence: {
        isValid: true,
        processedHash: 'hash-nom151',
        fileBase64: 'dG9rZW4tbm9tMTUx',
        evidenceId: 'nom151-1',
        issuedAt: new Date('2026-08-14T18:24:11.000Z'),
        certificatePdfBase64: 'JVBERi0xLjQK',
      },
    } as unknown as SealEntity;

    function signedDocument(overrides: Record<string, unknown> = {}) {
      return {
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
        signedHash: 'hash-firmado',
        originalHash: 'hash-original',
        totalPages: 12,
        createdBy: 'creator-1',
        ...overrides,
      };
    }

    beforeEach(() => {
      collaboratorRepository.find.mockResolvedValue([]);
      minioService.getFile.mockResolvedValue({
        secureUrl: 'https://minio/finalized-documents/object-key-1',
        expiresIn: 86400,
      });
      userService.findOne.mockResolvedValue({
        id: 'creator-1',
        email: 'creador@correo.com',
      });
    });

    it('lanza NotFoundException si el documento no existe, sin llamar a Minio', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(getPublicDocument.execute('missing-doc')).rejects.toThrow(
        NotFoundException,
      );
      expect(minioService.getFile).not.toHaveBeenCalled();
    });

    /**
     * Historia "Visualización pública de documentos firmados mediante MinIO": esta ruta no tiene
     * ningún control de acceso (cualquiera con el UUID la puede llamar), así que el gate por
     * status === SIGNED es la única defensa contra exponer el archivo de un documento que no
     * debería ser público todavía.
     */
    describe('documento pendiente de firmas', () => {
      it.each([
        DOCUMENT_STATUS_ENUM.CREATED,
        DOCUMENT_STATUS_ENUM.PENDING,
        DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
        DOCUMENT_STATUS_ENUM.REJECTED,
        DOCUMENT_STATUS_ENUM.EXPIRED,
        DOCUMENT_STATUS_ENUM.CANCELLED,
      ])(
        'con status=%s: nunca genera ni devuelve una URL de Minio',
        async (status) => {
          documentRepository.findOne.mockResolvedValue(
            signedDocument({ status }),
          );

          const result = await getPublicDocument.execute('doc-1');

          expect(minioService.getFile).not.toHaveBeenCalled();
          expect(result.data.isCompleted).toBe(false);
          expect(result.data.secureUrl).toBeNull();
          expect(result.data.expiresIn).toBeNull();
        },
      );

      /**
       * El corazón de la historia: un documento a medio firmar publica su nombre y a quién le
       * toca firmar, y NADA más. Ni hash, ni creador, ni constancia, ni descargas — y sobre todo
       * ningún estatus individual, que en una URL sin sesión sería un tablero de quién ya firmó.
       */
      it('solo expone el nombre del documento y los nombres de los firmantes', async () => {
        documentRepository.findOne.mockResolvedValue(
          signedDocument({ status: DOCUMENT_STATUS_ENUM.PENDING }),
        );
        collaboratorRepository.find.mockResolvedValue([
          buildSigner({ id: 'collab-1', signingOrder: 0 }),
          buildSigner({
            id: 'collab-2',
            userId: 'user-2',
            signingOrder: 1,
            status: SIGNEE_STATUS_ENUM.SIGNED,
            signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
            signedAt: new Date('2026-08-14T18:24:11.000Z'),
            ipAddress: '187.190.12.4',
          }),
        ]);

        const result = await getPublicDocument.execute('doc-1');

        expect(result.data).toEqual({
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.PENDING,
          isCompleted: false,
          // Un documento sin completar no espera constancia: no hay nada que sellar todavía.
          sealingPending: false,
          secureUrl: null,
          expiresIn: null,
          hash: null,
          totalPages: null,
          createdBy: null,
          conservationRecord: null,
          signers: [
            {
              id: 'collab-1',
              name: 'Firmante Uno',
              signatureType: null,
              signatureTypeLabel: '',
              legalBacking: '',
              ipAddress: '',
              signedAt: null,
              otpCode: null,
              certificateSerialNumber: null,
              electronicSignature: null,
            },
            {
              id: 'collab-2',
              name: 'Firmante Uno',
              signatureType: null,
              signatureTypeLabel: '',
              legalBacking: '',
              ipAddress: '',
              signedAt: null,
              otpCode: null,
              certificateSerialNumber: null,
              electronicSignature: null,
            },
          ],
          downloads: { nom151: false, timestamp: false, canonical: false },
          sealEvidence: {
            timestampFileBase64: null,
            integrityFileBase64: null,
          },
          integrityTsaCertificate: null,
        });
      });

      it('no consulta el sello ni al creador de un documento que sigue pendiente', async () => {
        documentRepository.findOne.mockResolvedValue(
          signedDocument({ status: DOCUMENT_STATUS_ENUM.PENDING }),
        );

        await getPublicDocument.execute('doc-1');

        expect(sealDocumentUseCase.findByDocumentId).not.toHaveBeenCalled();
        expect(userService.findOne).not.toHaveBeenCalled();
      });

      it('solo considera a los SIGNER: watchers y reviewers no salen en la vista pública', async () => {
        documentRepository.findOne.mockResolvedValue(
          signedDocument({ status: DOCUMENT_STATUS_ENUM.PENDING }),
        );

        await getPublicDocument.execute('doc-1');

        expect(collaboratorRepository.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              documentId: 'doc-1',
              colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
            },
          }),
        );
      });
    });

    describe('documento completado', () => {
      it('devuelve la URL prefirmada de Minio desde el bucket de finalizados', async () => {
        documentRepository.findOne.mockResolvedValue(signedDocument());

        const result = await getPublicDocument.execute('doc-1');

        // La vista pública comparte la versión definitiva (documento + hoja de firmas), igual que
        // el resto de las rutas de lectura.
        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        );
        expect(result.data).toEqual(
          expect.objectContaining({
            isCompleted: true,
            secureUrl: 'https://minio/finalized-documents/object-key-1',
            expiresIn: 86400,
          }),
        );
      });

      it('expone la información del documento: hash, páginas y creador', async () => {
        documentRepository.findOne.mockResolvedValue(signedDocument());

        const result = await getPublicDocument.execute('doc-1');

        expect(result.data).toEqual(
          expect.objectContaining({
            hash: 'hash-firmado',
            totalPages: 12,
            createdBy: 'creador@correo.com',
          }),
        );
      });

      /** Un documento firmado antes de que existiera `signedHash` no debe quedarse sin hash. */
      it('cae al hash original si el documento no tiene signedHash', async () => {
        documentRepository.findOne.mockResolvedValue(
          signedDocument({ signedHash: null }),
        );

        const result = await getPublicDocument.execute('doc-1');

        expect(result.data.hash).toBe('hash-original');
      });

      describe('constancia de conservación (NOM-151)', () => {
        it('devuelve la fecha de emisión del sello y habilita las tres descargas', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue(SEAL);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.conservationRecord).toEqual({
            // Los otros dos renglones viajan dentro del token RFC 3161 y nadie los expone por
            // separado (ver `toConservationRecord`): hoy son null por diseño, no por olvido.
            tsaCertificate: null,
            serialNumber: null,
            issuedAt: '2026-08-14T18:24:11.000Z',
          });
          expect(result.data.downloads).toEqual({
            nom151: true,
            timestamp: true,
            canonical: true,
          });
          expect(result.data.sealEvidence).toEqual({
            timestampFileBase64: 'dG9rZW4tdHM=',
            integrityFileBase64: 'dG9rZW4tbm9tMTUx',
          });
        });

        /**
         * Solo se sellan los documentos con firma AVANZADA (`sealAdvancedSignatures`) y el sellado
         * es best-effort: un documento de firma simple se completa sin constancia, y la vista
         * pública tiene que poder mostrarse igual.
         */
        it('sin sello: constancia en null y ninguna descarga habilitada', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue(null);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.conservationRecord).toBeNull();
          expect(result.data.downloads).toEqual({
            nom151: false,
            timestamp: false,
            canonical: false,
          });
          expect(result.data.sealEvidence).toEqual({
            timestampFileBase64: null,
            integrityFileBase64: null,
          });
        });

        it('habilita solo las descargas cuyo artefacto realmente vino en la respuesta del PSC', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue({
            ...SEAL,
            canonicalPayload: '',
            integrityEvidence: {
              ...SEAL.integrityEvidence,
              certificatePdfBase64: '',
            },
          } as unknown as SealEntity);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.downloads).toEqual({
            nom151: false,
            timestamp: true,
            canonical: false,
          });
        });

        it('la evidencia cruda para descarga viene de fileBase64, no de certificatePdfBase64', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue({
            ...SEAL,
            integrityEvidence: {
              ...SEAL.integrityEvidence,
              certificatePdfBase64: '',
            },
          } as unknown as SealEntity);

          const result = await getPublicDocument.execute('doc-1');

          // `downloads.nom151` sigue en false (mide `certificatePdfBase64`, la ruta de descarga del
          // backend), pero `sealEvidence.integrityFileBase64` sigue viniendo: son artefactos
          // distintos de la misma evidencia.
          expect(result.data.downloads.nom151).toBe(false);
          expect(result.data.sealEvidence.integrityFileBase64).toBe(
            'dG9rZW4tbm9tMTUx',
          );
        });
      });

      describe('certificado TSA de la evidencia NOM-151', () => {
        /**
         * CMS SignedData (DER, Base64) real, generado con `openssl cms -sign` sobre un
         * certificado autofirmado (`openssl req -x509 ... -set_serial 0x4A1B2C3D`). Mismo
         * fixture que `tsa-certificate.util.spec.ts`: serial=4A1B2C3D,
         * notBefore=2026-08-27T18:06:37.000Z.
         */
        const CMS_WITH_CERTIFICATE =
          'MIIDjwYJKoZIhvcNAQcCoIIDgDCCA3wCAQExDTALBglghkgBZQMEAgEwJAYJKoZIhvcNAQcBoBcEFWhvbGEtbXVuZG8tZXZpZGVuY2lhCqCCAa8wggGrMIIBUaADAgECAgRKGyw9MAoGCCqGSM49BAMCMDMxETAPBgNVBAMMCFRlc3QgVFNBMREwDwYDVQQKDAhUZXN0IFBTQzELMAkGA1UEBhMCTVgwHhcNMjYwODI3MTgwNjM3WhcNMjcwODI3MTgwNjM3WjAzMREwDwYDVQQDDAhUZXN0IFRTQTERMA8GA1UECgwIVGVzdCBQU0MxCzAJBgNVBAYTAk1YMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJHOJY30iMvggdywg6JP+hC8l7ogdCgDnrunBZkklArQbBkJAz6E9DtNVlMuzC9jypxWh5lbpX8Py4QiEHp+IV6NTMFEwHQYDVR0OBBYEFBUIxTafnILGpbiZEVcea2LGzAnsMB8GA1UdIwQYMBaAFBUIxTafnILGpbiZEVcea2LGzAnsMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANXcs8sKgBLuhrTNX8TYAYjkft9QwTSnEcp4ywPtr2xMAiAh8FUsFK68JhxcGDcKl509H9cOftJ6Pnnf4FaawZyuEzGCAY0wggGJAgEBMDswMzERMA8GA1UEAwwIVGVzdCBUU0ExETAPBgNVBAoMCFRlc3QgUFNDMQswCQYDVQQGEwJNWAIEShssPTALBglghkgBZQMEAgGggeQwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjYwODI3MTgwNjM3WjAvBgkqhkiG9w0BCQQxIgQgQ7XgrBofCLIuYAXovuRl4knoZu433yrmBFlRA5Xy9poweQYJKoZIhvcNAQkPMWwwajALBglghkgBZQMEASowCwYJYIZIAWUDBAEWMAsGCWCGSAFlAwQBAjAKBggqhkiG9w0DBzAOBggqhkiG9w0DAgICAIAwDQYIKoZIhvcNAwICAUAwBwYFKw4DAgcwDQYIKoZIhvcNAwICASgwCgYIKoZIzj0EAwIERzBFAiEAn04MlsE6WsTM1el7evE7uYXzZnke0/edGFRkWrK2ZEgCIE8207j6a9Uw+2oBN95tk9zOesY6LCyc6F4PwF/bvwmY';

        it('si integrityEvidence ya trae serie y fecha del certificado, los usa sin reprocesar el ASN.1', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue({
            ...SEAL,
            integrityEvidence: {
              ...SEAL.integrityEvidence,
              fileBase64: CMS_WITH_CERTIFICATE,
              certificateSerialNumber: 'YA-GUARDADO',
              certificateIssuedAt: new Date('2020-01-01T00:00:00.000Z'),
            },
          } as unknown as SealEntity);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.integrityTsaCertificate).toEqual({
            serialNumber: 'YA-GUARDADO',
            issuedAt: '2020-01-01T00:00:00.000Z',
          });
          // Si hubiera reprocesado, habría extraído 4A1B2C3D del fixture en vez de devolver el
          // valor ya guardado — y no habría razón para volver a persistir nada.
          expect(
            sealDocumentUseCase.persistIntegrityCertificateInfo,
          ).not.toHaveBeenCalled();
        });

        it('si faltan los datos del certificado, los extrae de fileBase64 y los persiste para no reprocesar después', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          const sealWithoutCertificateInfo = {
            ...SEAL,
            integrityEvidence: {
              ...SEAL.integrityEvidence,
              fileBase64: CMS_WITH_CERTIFICATE,
            },
          } as unknown as SealEntity;
          sealDocumentUseCase.findByDocumentId.mockResolvedValue(
            sealWithoutCertificateInfo,
          );

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.integrityTsaCertificate).toEqual({
            serialNumber: '4A1B2C3D',
            issuedAt: '2026-08-27T18:06:37.000Z',
          });
          expect(
            sealDocumentUseCase.persistIntegrityCertificateInfo,
          ).toHaveBeenCalledWith(sealWithoutCertificateInfo, {
            serialNumber: '4A1B2C3D',
            issuedAt: new Date('2026-08-27T18:06:37.000Z'),
            // El CN del emisor es lo que la tabla NOM-151 imprime como "Certificado (TSA)".
            subjectCommonName: 'Test TSA',
          });
        });

        it('si no se puede extraer nada del ASN.1, no muestra el certificado ni intenta persistir', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue(SEAL); // fileBase64 no es un CMS real

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.integrityTsaCertificate).toBeNull();
          expect(
            sealDocumentUseCase.persistIntegrityCertificateInfo,
          ).not.toHaveBeenCalled();
        });

        it('sin sello, el certificado también viene en null', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          sealDocumentUseCase.findByDocumentId.mockResolvedValue(null);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.integrityTsaCertificate).toBeNull();
        });
      });

      describe('evidencia por tipo de firma', () => {
        it('firma simple: OTP sí, número de serie y firma electrónica no', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          collaboratorRepository.find.mockResolvedValue([
            buildSigner({
              id: 'collab-1',
              status: SIGNEE_STATUS_ENUM.SIGNED,
              signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
              signedAt: new Date('2026-08-14T18:24:11.000Z'),
              ipAddress: '187.190.12.4',
              geoLoc: { latitude: 19.4326, longitude: -99.1332 },
            }),
          ]);
          verificationCodeService.findConsumedCode.mockResolvedValue('482915');

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.signers).toEqual([
            {
              id: 'collab-1',
              name: 'Firmante Uno',
              signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
              signatureTypeLabel: SIMPLE_SIGNATURE_TYPE_LABEL,
              legalBacking: SIMPLE_SIGNATURE_BACKING_LABEL,
              ipAddress: '187.190.12.4',
              signedAt: '2026-08-14T18:24:11.000Z',
              otpCode: '482915',
              certificateSerialNumber: null,
              electronicSignature: null,
            },
          ]);
          expect(verificationCodeService.findConsumedCode).toHaveBeenCalledWith(
            'doc-1',
            'collab-1',
            VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
          );
        });

        it('firma avanzada: número de serie y firma electrónica sí, OTP no', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          collaboratorRepository.find.mockResolvedValue([
            buildSigner({
              id: 'collab-1',
              status: SIGNEE_STATUS_ENUM.SIGNED,
              signatureType: SIGNATURE_TYPE_ENUM.FIEL,
              signedAt: new Date('2026-08-14T18:00:00.000Z'),
              ipAddress: '187.190.12.4',
              geoLoc: { latitude: 19.4326, longitude: -99.1332 },
              advancedSignature: {
                signatureBase64: 'firma-base64',
                algorithm: 'sha256',
                signedAt: '2026-08-14T18:24:11.000Z',
                certificate: {
                  rfc: 'XAXX010101000',
                  name: 'MANUEL BALDERRAMA CHAVEZ',
                  serialNumber: '00001000000512345678',
                },
              },
            } as unknown as Partial<CollaboratorEntity>),
          ]);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.signers).toEqual([
            {
              id: 'collab-1',
              // El nombre del certificado gana al del perfil: es el que el SAT tiene registrado.
              name: 'MANUEL BALDERRAMA CHAVEZ',
              signatureType: SIGNATURE_TYPE_ENUM.FIEL,
              signatureTypeLabel: ADVANCED_SIGNATURE_TYPE_LABEL,
              legalBacking: ADVANCED_SIGNATURE_BACKING_LABEL,
              ipAddress: '187.190.12.4',
              // El momento del firmado criptográfico, no el del registro en base.
              signedAt: '2026-08-14T18:24:11.000Z',
              otpCode: null,
              certificateSerialNumber: '00001000000512345678',
              electronicSignature: 'firma-base64',
            },
          ]);
          expect(
            verificationCodeService.findConsumedCode,
          ).not.toHaveBeenCalled();
        });

        /** La verificación por OTP depende de `requiresVerification`: no siempre hay código. */
        it('firma simple sin código consumido: otpCode en null, no cadena vacía', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          collaboratorRepository.find.mockResolvedValue([
            buildSigner({
              id: 'collab-1',
              signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
              signedAt: new Date('2026-08-14T18:24:11.000Z'),
            }),
          ]);
          verificationCodeService.findConsumedCode.mockResolvedValue(null);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.signers[0].otpCode).toBeNull();
        });

        /**
         * La ubicación desde la que firmó una persona NO sale por esta ruta, aunque el
         * colaborador la tenga registrada y la hoja de firmas del PDF sí la imprima: la hoja
         * viaja dentro del documento, hacia quienes son parte de él, mientras que esta respuesta
         * la obtiene cualquiera que tenga el id, sin sesión y sin cuenta.
         *
         * Se afirma sobre la AUSENCIA de la propiedad y no sobre un `null`: dejar el campo en la
         * respuesta invitaba a volver a llenarlo.
         */
        it('nunca publica la geolocalización del firmante, aunque esté registrada', async () => {
          documentRepository.findOne.mockResolvedValue(signedDocument());
          collaboratorRepository.find.mockResolvedValue([
            buildSigner({
              id: 'collab-1',
              status: SIGNEE_STATUS_ENUM.SIGNED,
              signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
              geoLoc: { latitude: 19.4326, longitude: -99.1332 },
            }),
          ]);

          const result = await getPublicDocument.execute('doc-1');

          expect(result.data.signers[0]).not.toHaveProperty('geoLocation');
          expect(JSON.stringify(result.data)).not.toContain('19.4326');
        });
      });
    });
  });

  describe('getPublicSealArtifact', () => {
    const SEAL = {
      canonicalPayload: 'v1||12:hola-mundo',
      timestampEvidence: { fileBase64: 'dG9rZW4tdHM=' },
      integrityEvidence: { certificatePdfBase64: 'JVBERi0xLjQK' },
    } as unknown as SealEntity;

    beforeEach(() => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
      });
      sealDocumentUseCase.findByDocumentId.mockResolvedValue(SEAL);
    });

    it('devuelve la constancia NOM-151 decodificada como PDF', async () => {
      const result = await getPublicSealArtifact.execute(
        'doc-1',
        SEAL_ARTIFACT_ENUM.NOM151,
      );

      expect(result.contentType).toBe('application/pdf');
      expect(result.fileName).toBe('constancia-nom151-doc-1.pdf');
      expect(result.content).toEqual(Buffer.from('JVBERi0xLjQK', 'base64'));
    });

    it('devuelve el sello de tiempo como token RFC 3161', async () => {
      const result = await getPublicSealArtifact.execute(
        'doc-1',
        SEAL_ARTIFACT_ENUM.TIMESTAMP,
      );

      expect(result.contentType).toBe('application/timestamp-reply');
      expect(result.fileName).toBe('sello-de-tiempo-doc-1.tsr');
      expect(result.content).toEqual(Buffer.from('dG9rZW4tdHM=', 'base64'));
    });

    /**
     * El XML canónico se entrega TAL CUAL: el proveedor ya lo emite como XML —con su propio
     * namespace— y sólo lo transporta en Base64, que `SealMapper` decodifica al persistir. No se
     * envuelve ni se reescribe nada, porque es lo único que conserva la propiedad que hace
     * verificable la constancia.
     */
    describe('XML canónico', () => {
      const XML_CANONICO =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<signatureSeal xmlns="https://app.firma-lo.com/schemas/signature-seal/v1" hashVersion="v1">' +
        '<file documentId="doc-1"></file></signatureSeal>';

      beforeEach(() => {
        sealDocumentUseCase.findByDocumentId.mockResolvedValue({
          ...SEAL,
          canonicalPayload: XML_CANONICO,
        } as unknown as SealEntity);
      });

      it('lo entrega como XML y con extensión .xml', async () => {
        const result = await getPublicSealArtifact.execute(
          'doc-1',
          SEAL_ARTIFACT_ENUM.CANONICAL,
        );

        expect(result.contentType).toBe('application/xml; charset=utf-8');
        expect(result.fileName).toBe('xml-canonico-doc-1.xml');
      });

      /**
       * Lo que hace verificable al archivo: `sha256` de lo descargado tiene que reproducir el
       * hash sellado. Cualquier transformación —envolverlo, escaparlo, recodificarlo— lo rompe.
       */
      it('entrega el XML byte por byte, sin transformarlo', async () => {
        const content = (
          await getPublicSealArtifact.execute(
            'doc-1',
            SEAL_ARTIFACT_ENUM.CANONICAL,
          )
        ).content;

        expect(content.toString('utf-8')).toBe(XML_CANONICO);
        expect(createHash('sha256').update(content).digest('hex')).toBe(
          createHash('sha256').update(XML_CANONICO, 'utf-8').digest('hex'),
        );
      });
    });

    it('404 si el documento todavía no se ha completado de firmar', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.PENDING,
      });

      await expect(
        getPublicSealArtifact.execute('doc-1', SEAL_ARTIFACT_ENUM.NOM151),
      ).rejects.toThrow(NotFoundException);
      expect(sealDocumentUseCase.findByDocumentId).not.toHaveBeenCalled();
    });

    it('404 si el documento no tiene sello', async () => {
      sealDocumentUseCase.findByDocumentId.mockResolvedValue(null);

      await expect(
        getPublicSealArtifact.execute('doc-1', SEAL_ARTIFACT_ENUM.NOM151),
      ).rejects.toThrow(NotFoundException);
    });

    it('404 si ese artefacto en concreto no vino en la respuesta del PSC', async () => {
      sealDocumentUseCase.findByDocumentId.mockResolvedValue({
        ...SEAL,
        integrityEvidence: { certificatePdfBase64: '' },
      } as unknown as SealEntity);

      await expect(
        getPublicSealArtifact.execute('doc-1', SEAL_ARTIFACT_ENUM.NOM151),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * `GET /document/file/:id` debe resolver el bucket de MinIO a partir del estatus del documento
   * (STATUS_BUCKET_MAP): un documento ya firmado tiene que servirse desde el bucket de firmados,
   * no desde el original — devolver la versión sin firmar de un documento firmado fue un bug
   * reportado.
   */
  /**
   * Historia "Generar código QR para firmas avanzadas": el destino del QR estampado en el
   * documento. Ruta pública sin autenticación, así que el gate es estricto y todo lo que no sea
   * una firma avanzada ya completada responde 404 (no 403: un 403 confirmaría que ese colaborador
   * existe, y cualquiera puede llamar esta ruta con un UUID).
   */
  describe('getAdvancedSignaturePublicView', () => {
    const SIGNED_AT = new Date('2026-08-14T18:24:11.000Z');

    function advancedCollaborator(overrides: Record<string, unknown> = {}) {
      return {
        id: 'collaborator-1',
        documentId: 'doc-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        status: SIGNEE_STATUS_ENUM.SIGNED,
        signedAt: SIGNED_AT,
        firstName: 'MANUEL',
        lastName: 'BALDERRAMA',
        advancedSignature: {
          certificate: {
            name: 'MANUEL BALDERRAMA CHAVEZ',
            rfc: 'BACM800101ABC',
            serialNumber: '00001000000512345678',
          },
        },
        ...overrides,
      };
    }

    beforeEach(() => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
      });
    });

    it('devuelve quién firmó y cuándo', async () => {
      collaboratorRepository.findOne = jest
        .fn()
        .mockResolvedValue(advancedCollaborator());

      const result = await getPublicAdvancedSignature.execute(
        'doc-1',
        'collaborator-1',
      );

      expect(result.data).toEqual({
        documentId: 'doc-1',
        fileName: 'contrato.pdf',
        signerName: 'MANUEL BALDERRAMA CHAVEZ',
        rfc: 'BACM800101ABC',
        certificateSerialNumber: '00001000000512345678',
        signedAt: SIGNED_AT.toISOString(),
      });
    });

    // El nombre del certificado es el que el SAT tiene registrado; el del perfil es el respaldo
    // para firmas anteriores a que se guardara esa evidencia.
    it('cae al nombre del perfil si la firma no guardó certificado', async () => {
      collaboratorRepository.findOne = jest
        .fn()
        .mockResolvedValue(advancedCollaborator({ advancedSignature: null }));

      const result = await getPublicAdvancedSignature.execute(
        'doc-1',
        'collaborator-1',
      );

      expect(result.data.signerName).toContain('MANUEL');
      expect(result.data.rfc).toBeNull();
      expect(result.data.certificateSerialNumber).toBeNull();
    });

    // Criterio: "el QR no se genera ni se muestra mientras la firma avanzada esté pendiente" — y
    // su constancia tampoco debe poder consultarse antes de que la firma exista.
    it('responde 404 si la firma avanzada todavía está pendiente', async () => {
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(
        advancedCollaborator({
          status: SIGNEE_STATUS_ENUM.PENDING,
          signedAt: null,
        }),
      );

      await expect(
        getPublicAdvancedSignature.execute('doc-1', 'collaborator-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('responde 404 para una firma simple: su constancia es la rúbrica visible, no este QR', async () => {
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(
        advancedCollaborator({
          signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        }),
      );

      await expect(
        getPublicAdvancedSignature.execute('doc-1', 'collaborator-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('responde 404 si el colaborador no pertenece al documento', async () => {
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        getPublicAdvancedSignature.execute('doc-1', 'otro-colaborador'),
      ).rejects.toThrow(NotFoundException);

      // La pertenencia se filtra en la consulta, no después: no se puede leer la firma de un
      // documento pasando el id de un colaborador de otro.
      expect(collaboratorRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'otro-colaborador',
            documentId: 'doc-1',
          }),
        }),
      );
    });
  });

  describe('bucket según el estatus en el resto de las rutas de lectura', () => {
    const detailBucketCases: Array<[DOCUMENT_STATUS_ENUM, BUCKET_TYPES_ENUM]> =
      [
        [DOCUMENT_STATUS_ENUM.SIGNED, BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS],
        [
          DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        ],
        [DOCUMENT_STATUS_ENUM.REJECTED, BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS],
        [DOCUMENT_STATUS_ENUM.CANCELLED, BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS],
        [DOCUMENT_STATUS_ENUM.PENDING, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      ];

    it.each(detailBucketCases)(
      'findDetailForUser (GET /document/:id) con status=%s sirve el archivo desde %s',
      async (status, expectedBucket) => {
        documentRepository.findOne.mockResolvedValue({
          id: 'doc-1',
          fileName: 'contrato.pdf',
          fileType: 'application/pdf',
          totalPages: 1,
          objectKey: 'object-key-1',
          status,
          createdBy: 'creator-1',
          requestedBy: { firstName: 'Creador', lastName: 'Uno' },
          collaborators: [buildSigner({ userId: 'user-1' })],
        } as unknown as DocumentEntity);

        await getDocument.execute('doc-1', 'user-1');

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          expectedBucket,
        );
      },
    );

    it('findWithFilters (GET /document?withUrl=true) sirve cada documento desde el bucket de su propio estatus', async () => {
      const qb: any = {};
      [
        'where',
        'andWhere',
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
      ].forEach((method) => {
        qb[method] = jest.fn().mockReturnValue(qb);
      });
      qb.getManyAndCount = jest.fn().mockResolvedValue([
        [
          {
            id: 'doc-firmado',
            fileName: 'firmado.pdf',
            objectKey: 'object-key-firmado',
            status: DOCUMENT_STATUS_ENUM.SIGNED,
            requestedBy: { firstName: 'Creador', lastName: 'Uno' },
            collaborators: [],
          },
          {
            id: 'doc-pendiente',
            fileName: 'pendiente.pdf',
            objectKey: 'object-key-pendiente',
            status: DOCUMENT_STATUS_ENUM.PENDING,
            requestedBy: { firstName: 'Creador', lastName: 'Uno' },
            collaborators: [],
          },
        ],
        2,
      ]);
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await getDocuments.execute('user-1', 'account-1', {
        page: 1,
        limit: 10,
        withUrl: true,
      } as any);

      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-firmado',
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
      );
      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-pendiente',
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
    });
  });

  // Test de caracterización (Fase 0/3 de la migración ER-V2): findDetailForUser() y sign()
  // calculan "a quién le toca firmar" de forma independiente (una en memoria sobre
  // document.collaborators, la otra sobre signerCollaborators cargados del repositorio).
  // Ambas pasan por la misma función compartida (getNextPendingSigner/isSignerTurn), así que
  // deben concordar siempre en el mismo escenario.
  describe('consistencia del turno de firma entre findDetailForUser y sign', () => {
    // A ya firmó; le toca a B (menor signingOrder entre los pendientes); C debe esperar.
    const signerA = buildSigner({
      id: 'p-a',
      userId: 'user-a',
      signingOrder: 0,
      status: SIGNEE_STATUS_ENUM.SIGNED,
    });
    const signerB = buildSigner({
      id: 'p-b',
      userId: 'user-b',
      signingOrder: 1,
    });
    const signerC = buildSigner({
      id: 'p-c',
      userId: 'user-c',
      signingOrder: 2,
    });
    const participants = [signerA, signerB, signerC];

    function mockDetailDocument() {
      return {
        id: 'doc-1',
        fileName: 'contrato.pdf',
        fileType: 'application/pdf',
        totalPages: 1,
        objectKey: 'object-key-1',
        status: DOCUMENT_STATUS_ENUM.PENDING,
        createdBy: 'creator-1',
        requestedBy: { firstName: 'Creador', lastName: 'Uno' },
        collaborators: participants,
      } as unknown as DocumentEntity;
    }

    it('findDetailForUser marca canSign solo para el firmante B (A ya firmó, C debe esperar)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDetailDocument());

      const resultB = await getDocument.execute('doc-1', 'user-b');
      expect(resultB.data.canSign).toBe(true);

      const resultC = await getDocument.execute('doc-1', 'user-c');
      expect(resultC.data.canSign).toBe(false);
    });

    it('sign() acepta al firmante B y rechaza a C con ForbiddenException, igual que findDetailForUser', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDetailDocument() as unknown as DocumentEntity,
      );
      collaboratorRepository.find.mockResolvedValue(participants);

      await expect(
        signDocument.execute('doc-1', 'user-c', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(ForbiddenException);

      const resultB = await signDocument.execute(
        'doc-1',
        'user-b',
        undefined,
        TEST_GEOLOCATION,
      );
      expect(resultB.success).toBe(true);
    });

    it('con isSequential=false, findDetailForUser marca canSign=true para cualquier firmante PENDING, no solo B', async () => {
      documentRepository.findOne.mockResolvedValue({
        ...mockDetailDocument(),
        isSequential: false,
      });

      const resultC = await getDocument.execute('doc-1', 'user-c');
      expect(resultC.data.canSign).toBe(true);
    });

    it('bug corregido: un colaborador invitado solo por email (accountId todavía null) SÍ puede leer el documento — el listado ya se lo mostraba y el detalle lo rechazaba con 403', async () => {
      const invitedByEmail = buildSigner({
        id: 'p-b',
        userId: 'user-b',
        signingOrder: 1,
        accountId: null,
        account: null,
        email: 'Firmante.B@Correo.com',
      });
      documentRepository.findOne.mockResolvedValue({
        ...mockDetailDocument(),
        collaborators: [signerA, invitedByEmail, signerC],
      } as unknown as DocumentEntity);
      userService.findOne.mockResolvedValue({
        id: 'user-b',
        email: 'firmante.b@correo.com',
      });

      const result = await getDocument.execute('doc-1', 'user-b');

      expect(result.data.canSign).toBe(true);
      expect(result.data.myStatus).toBe(SIGNEE_STATUS_ENUM.PENDING);
    });

    it('leer NO vincula la cuenta (ver historia "Vinculación del documento debe postergarse hasta el inicio de sesión y validación de RFC"): la vinculación sigue siendo una acción explícita', async () => {
      const invitedByEmail = buildSigner({
        id: 'p-b',
        userId: 'user-b',
        signingOrder: 1,
        accountId: null,
        account: null,
        email: 'firmante.b@correo.com',
      });
      documentRepository.findOne.mockResolvedValue({
        ...mockDetailDocument(),
        collaborators: [signerA, invitedByEmail, signerC],
      } as unknown as DocumentEntity);
      userService.findOne.mockResolvedValue({
        id: 'user-b',
        email: 'firmante.b@correo.com',
      });

      await getDocument.execute('doc-1', 'user-b');

      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    });

    it('un usuario ajeno al documento sigue recibiendo ForbiddenException', async () => {
      const invitedByEmail = buildSigner({
        id: 'p-b',
        userId: 'user-b',
        signingOrder: 1,
        accountId: null,
        account: null,
        email: 'firmante.b@correo.com',
      });
      documentRepository.findOne.mockResolvedValue({
        ...mockDetailDocument(),
        collaborators: [signerA, invitedByEmail, signerC],
      } as unknown as DocumentEntity);
      userService.findOne.mockResolvedValue({
        id: 'user-x',
        email: 'intruso@correo.com',
      });

      await expect(getDocument.execute('doc-1', 'user-x')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('tras una vinculación explícita previa (linkPendingCollaboratorAccount), findDetailForUser sí encuentra al colaborador por accountId y calcula canSign/myStatus normalmente', async () => {
      const pendingCollaborator = buildSigner({
        id: 'p-b',
        userId: 'user-b',
        signingOrder: 1,
      });
      const linkedDetailDocument = {
        ...mockDetailDocument(),
        collaborators: [signerA, pendingCollaborator, signerC],
      };

      documentRepository.findOne.mockResolvedValue(
        linkedDetailDocument as unknown as DocumentEntity,
      );

      const result = await getDocument.execute('doc-1', 'user-b');

      expect(result.data.canSign).toBe(true);
      expect(result.data.myStatus).toBe(SIGNEE_STATUS_ENUM.PENDING);
    });
  });

  describe('linkPendingCollaboratorAccount', () => {
    it('vincula accountId cuando hay una invitación SIGNER pendiente con el mismo email (case-insensitive)', async () => {
      userService.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'maria@correo.com',
      });
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'collaborator-1',
        email: 'Maria@Correo.com',
        accountId: null,
      });

      const result = await linkDocumentCollaborator.execute('doc-1', 'user-2');

      expect(result.data.linked).toBe(true);
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        'collaborator-1',
        { accountId: 'account-of-user-2' },
      );
    });

    it('retorna linked:false y no toca nada si no hay ninguna invitación pendiente con ese email', async () => {
      userService.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'nadie@correo.com',
      });
      collaboratorRepository.findOne.mockResolvedValue(null);

      const result = await linkDocumentCollaborator.execute('doc-1', 'user-2');

      expect(result.data.linked).toBe(false);
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    });
  });
  /**
   * Los tres endpoints de borrador comparten la misma regla: sólo se puede tocar un documento
   * que todavía está en CREATED. Después de salir a firmar, lo que los invitados vieron tiene
   * que seguir siendo exactamente lo que se les pidió firmar.
   */
  describe('update / remove / submitForAuthorization', () => {
    const draft = {
      id: 'doc-1',
      createdBy: 'creator-1',
      fileName: 'contrato.pdf',
      objectKey: 'object-key-1',
      status: DOCUMENT_STATUS_ENUM.CREATED,
      ipAddress: '127.0.0.1',
      signatureCoordinates: [],
    };

    describe('UpdateDocumentUseCase', () => {
      it('guarda las coordenadas y devuelve la URL vigente del archivo', async () => {
        documentRepository.findOne.mockResolvedValue(draft);

        const result = await updateDocument.execute('doc-1', 'creator-1', {
          signatures: [],
        } as never);

        expect(documentRepository.update).toHaveBeenCalledWith('doc-1', {
          signatureCoordinates: { signatures: [] },
        });
        expect(result.data.secureUrl).toBe('https://minio/file');
      });

      it('reemplaza el archivo en MinIO cuando se envia uno nuevo', async () => {
        documentRepository.findOne.mockResolvedValue(draft);
        minioService.replaceFile.mockResolvedValue({
          status: FILE_STATUS_ENUM.FILE_OVERWRITTEN,
        });
        const file = { originalname: 'nuevo.pdf' } as Express.Multer.File;

        await updateDocument.execute('doc-1', 'creator-1', undefined, file);

        expect(minioService.replaceFile).toHaveBeenCalledWith(
          'object-key-1',
          { file, name: 'nuevo.pdf' },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );
      });

      it('rechaza una peticion que no trae ni archivo ni coordenadas', async () => {
        documentRepository.findOne.mockResolvedValue(draft);

        await expect(
          updateDocument.execute('doc-1', 'creator-1'),
        ).rejects.toThrow(BadRequestException);
        expect(documentRepository.update).not.toHaveBeenCalled();
      });

      it('rechaza a quien no creo el documento', async () => {
        documentRepository.findOne.mockResolvedValue(draft);

        await expect(
          updateDocument.execute('doc-1', 'otro-usuario', {} as never),
        ).rejects.toThrow(ForbiddenException);
      });

      it('rechaza un documento que ya salio a firmar', async () => {
        documentRepository.findOne.mockResolvedValue({
          ...draft,
          status: DOCUMENT_STATUS_ENUM.PENDING,
        });

        await expect(
          updateDocument.execute('doc-1', 'creator-1', {} as never),
        ).rejects.toThrow(BadRequestException);
        expect(documentRepository.update).not.toHaveBeenCalled();
      });
    });

    describe('DeleteDocumentUseCase', () => {
      it('borra el archivo y la fila', async () => {
        documentRepository.findOne.mockResolvedValue(draft);
        minioService.deleteFile.mockResolvedValue({
          message: { status: FILE_STATUS_ENUM.FILE_DELETED },
        });

        const result = await deleteDocument.execute('doc-1', 'creator-1');

        expect(minioService.deleteFile).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );
        expect(documentRepository.delete).toHaveBeenCalledWith({ id: 'doc-1' });
        expect(result.success).toBe(true);
      });

      it('rechaza a quien no creo el documento', async () => {
        documentRepository.findOne.mockResolvedValue(draft);

        await expect(
          deleteDocument.execute('doc-1', 'otro-usuario'),
        ).rejects.toThrow(ForbiddenException);
        expect(minioService.deleteFile).not.toHaveBeenCalled();
      });

      /** Un documento que ya salio a firmar es evidencia: no se borra. */
      it('rechaza un documento que ya no esta en CREATED', async () => {
        documentRepository.findOne.mockResolvedValue({
          ...draft,
          status: DOCUMENT_STATUS_ENUM.SIGNED,
        });

        await expect(
          deleteDocument.execute('doc-1', 'creator-1'),
        ).rejects.toThrow(BadRequestException);
        expect(documentRepository.delete).not.toHaveBeenCalled();
      });
    });

    describe('SubmitDocumentForAuthorizationUseCase', () => {
      it('pasa el documento a PENDING, audita y notifica al primer firmante', async () => {
        documentRepository.findOne.mockResolvedValue({ ...draft });
        collaboratorRepository.find.mockResolvedValue([]);

        const result = await submitForAuthorization.execute(
          'doc-1',
          'creator-1',
        );

        expect(documentRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: DOCUMENT_STATUS_ENUM.PENDING }),
        );
        expect(documentEventsProducer.emitSentToSign).toHaveBeenCalledWith({
          documentId: 'doc-1',
          fileName: 'contrato.pdf',
          actorUserId: 'creator-1',
        });
        expect(result.success).toBe(true);
      });

      /**
       * La solicitud ya quedó registrada y visible en la bandeja de quien tiene que firmar: un
       * fallo del proveedor de correo no debe deshacerla ni devolver un error a quien la mandó.
       */
      it('no falla si no se pudo notificar al primer firmante', async () => {
        documentRepository.findOne.mockResolvedValue({ ...draft });
        collaboratorRepository.find.mockRejectedValue(
          new Error('base de datos caida'),
        );
        jest
          .spyOn(submitForAuthorization['logger'], 'error')
          .mockImplementation(() => undefined);

        const result = await submitForAuthorization.execute(
          'doc-1',
          'creator-1',
        );

        expect(result.success).toBe(true);
      });

      it('rechaza a quien no creo el documento', async () => {
        documentRepository.findOne.mockResolvedValue(draft);

        await expect(
          submitForAuthorization.execute('doc-1', 'otro-usuario'),
        ).rejects.toThrow(ForbiddenException);
        expect(documentRepository.save).not.toHaveBeenCalled();
      });

      it('rechaza un documento que ya habia salido a firmar', async () => {
        documentRepository.findOne.mockResolvedValue({
          ...draft,
          status: DOCUMENT_STATUS_ENUM.PENDING,
        });

        await expect(
          submitForAuthorization.execute('doc-1', 'creator-1'),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('GetDocumentFileUrlUseCase', () => {
    /**
     * El acceso se comprueba antes de resolver nada: sin esto, un tercero con el UUID obtendría
     * una URL prefirmada del archivo aunque no tenga nada que ver con el documento.
     */
    it('comprueba el acceso antes de generar la URL', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        createdBy: 'creator-1',
        objectKey: 'object-key-1',
        status: DOCUMENT_STATUS_ENUM.CREATED,
      });

      const result = await getDocumentFileUrl.execute('doc-1', 'creator-1');

      expect(result.secureUrl).toBe('https://minio/file');
    });

    it('no genera ninguna URL si el usuario no tiene acceso', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        createdBy: 'creator-1',
        objectKey: 'object-key-1',
        status: DOCUMENT_STATUS_ENUM.CREATED,
      });
      collaboratorRepository.findOne.mockResolvedValue(null);
      userService.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'ajeno@correo.com',
      });

      await expect(
        getDocumentFileUrl.execute('doc-1', 'user-2'),
      ).rejects.toThrow(ForbiddenException);
      expect(minioService.getFile).not.toHaveBeenCalled();
    });
  });
});
