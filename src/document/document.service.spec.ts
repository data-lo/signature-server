import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from './enum/signee-status.enum';
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
import { VerificationCodeService } from './verification-code.service';
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';
import { DocumentTransactionService } from './document-transaction.service';
import { collaboratorDisplayName } from './utils/collaborator-display.util';
import { EfirmaService } from 'src/efirma/efirma.service';
import { SealDocumentUseCase } from './seal/use-cases/seal-document.use-case';
import { SummaryDocumentService } from './summary-document/summary-document.service';
import { SignatureQrService } from './services/signature-qr.service';
import { SIGNATURE_TYPE_ENUM } from './enum/signature-type.enum';

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

function buildSigner(
  overrides: Partial<CollaboratorEntity> & { userId?: string } = {},
) {
  const userId = overrides.userId ?? 'user-1';
  const { userId: _omit, ...entityOverrides } = overrides;
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

describe('DocumentService', () => {
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
  let summaryDocumentService: Record<string, jest.Mock>;
  let signatureQrService: Record<string, jest.Mock>;

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
          serialNumber: '00001000000512345678',
          certificateNumber: '30001000000400002434',
          certificatePem: '-----BEGIN CERTIFICATE-----...',
        },
      }),
    };
    sealDocumentUseCase = {
      create: jest.fn().mockResolvedValue({ id: 'seal-1' }),
    };
    summaryDocumentService = {
      generateSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas')),
    };
    signatureQrService = {
      generateAdvancedSignaturePng: jest
        .fn()
        .mockResolvedValue(Buffer.from('qr-png')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
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
        {
          provide: SummaryDocumentService,
          useValue: summaryDocumentService,
        },
        { provide: SignatureQrService, useValue: signatureQrService },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
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
      const result = await service.create(
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
        service.create(
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

      await service.create(
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

      await service.create(
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
        service.create('creator-1', undefined as any, dto, file, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza con ForbiddenException si el creador no pertenece a la cuenta activa', async () => {
      accountMemberService.assertIsActiveMember.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(
        service.create('creator-1', 'account-ajena', dto, file, '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si no se proporciona archivo', async () => {
      await expect(
        service.create(
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
        service.create('creator-1', 'account-1', dupDto, file, '127.0.0.1'),
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
        service.create('creator-1', 'account-1', dupDto, file, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si ya existe un documento propio con el mismo nombre en CREATED/PENDING', async () => {
      documentRepository.findOne.mockImplementation(async (options: any) => {
        if (options?.where?.fileName) return { id: 'existing-doc' };
        return null;
      });

      await expect(
        service.create('creator-1', 'account-1', dto, file, '127.0.0.1'),
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
        service.findWithFilters('user-1', undefined as any, query),
      ).rejects.toThrow(BadRequestException);
      expect(documentRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rechaza con ForbiddenException si el usuario no pertenece a la cuenta activa', async () => {
      accountMemberService.assertIsActiveMember.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(
        service.findWithFilters('user-1', 'account-ajena', query),
      ).rejects.toThrow(ForbiddenException);
    });

    it('filtra el listado por accountId cuando la cuenta activa es PERSONAL', async () => {
      const qb = createMockQueryBuilder();
      documentRepository.createQueryBuilder.mockReturnValue(qb);
      accountMemberService.assertIsActiveMember.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await service.findWithFilters('user-1', 'account-1', query);

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

      await service.findWithFilters('user-1', 'account-org-member-1', query);

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

      await service.findWithFilters('user-1', 'account-1', {
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

      await service.findWithFilters('user-1', 'account-1', {
        ...query,
        participantEmail: 'Juan.Perez@Mail.com',
      } as any);

      const participantClause = qb.andWhere.mock.calls.find(
        ([sql]: [string]) => sql.includes('SELECT c.document_id'),
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

      await service.findWithFilters('user-1', 'account-1', {
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

      await service.findWithFilters('user-1', 'account-1', {
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

      const result = await service.findWithFilters(
        'user-1',
        'account-1',
        query,
      );

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

      const result = await service.findWithFilters(
        'user-1',
        'account-1',
        query,
      );

      expect(result.data[0]).toEqual(
        expect.objectContaining({ creatorRfc: null }),
      );
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

      const result = await service.sign(
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

        await service.sign('doc-1', 'user-1', efirmaInput(), TEST_GEOLOCATION);
        return { document, signer };
      }

      /**
       * Historia "Actualizar contenido del código QR en firma avanzada": el código ya no lleva
       * solo un enlace, sino los datos del firmante y del evento de firma.
       */
      it('genera el QR con los datos del firmante y de esa firma', async () => {
        const { signer } = await signAdvanced();

        expect(
          signatureQrService.generateAdvancedSignaturePng,
        ).toHaveBeenCalledTimes(1);
        const [data] =
          signatureQrService.generateAdvancedSignaturePng.mock.calls[0];
        expect(data).toEqual(
          expect.objectContaining({
            // Nombre y RFC del certificado del SAT, no los del perfil.
            signerName: 'Firmante Uno',
            rfc: 'XAXX010101000',
            ipAddress: signer.ipAddress,
            geoLocation: TEST_GEOLOCATION,
            signedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        );
        expect(data.verificationUrl).toContain(
          `/public/documents/doc-1/signatures/${signer.id}`,
        );
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

        await service.sign('doc-1', 'user-1', efirmaInput(), TEST_GEOLOCATION);

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

        await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

        await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);
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

        const result = await service.sign(
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

        await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
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

      const result = await service.sign(
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

        await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);
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
        expect(info.cipher).toEqual(expect.any(String));
        expect(signers).toEqual([
          expect.objectContaining({
            name: 'Firmante Uno',
            ipAddress: '127.0.0.1',
            geoLocation: '19.4326, -99.1332',
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
          service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
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

      await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-b', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-b', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

      await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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

      const result = await service.sign(
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
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el usuario no es firmante del documento', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
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
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si aún no es el turno del firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ id: 'p-0', userId: 'user-0', signingOrder: 0 }),
        buildSigner({ id: 'p-1', userId: 'user-1', signingOrder: 1 }),
      ]);

      await expect(
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rechaza si el firmante no tiene credencial de firma activa', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      signatureService.findOne.mockResolvedValue({
        isActive: false,
        signatureObjectKey: null,
        officialCardObjectKey: null,
      });

      await expect(
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(BadRequestException);
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
        service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION),
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

      const result = await service.sign(
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

      const result = await service.sign(
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

      const result = await service.sign(
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

        const result = await service.sign(
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
          return service.sign(
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
                  serialNumber: '00001000000512345678',
                  certificateNumber: '30001000000400002434',
                  certificatePem: '-----BEGIN CERTIFICATE-----...',
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
                serialNumber: '1',
                certificateNumber: '2',
                certificatePem: 'pem-a',
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

          await service.sign('doc-1', 'user-1', undefined, TEST_GEOLOCATION);

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
            service.sign('doc-1', 'user-1', input, TEST_GEOLOCATION),
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
          service.sign(
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
            service.sign('doc-1', 'user-1', input, TEST_GEOLOCATION),
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
          service.sign(
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
          service.sign(
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

      await service.sign('doc-1', 'user-1', undefined, geolocation);

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

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
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

    it('rechaza el documento, estampa marca de agua y notifica al creador', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      const result = await service.reject('doc-1', 'user-1', 'No es válido');

      expect(result.success).toBe(true);
      expect(documentSigningService.stampRejectedWatermark).toHaveBeenCalled();
      expect(emailService.sendDocumentRejectedNotification).toHaveBeenCalled();
      expect(documentEventsProducer.emitRejected).toHaveBeenCalled();
    });

    it('rechaza con BadRequestException si el documento no está PENDING', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.SIGNED }),
      );

      await expect(service.reject('doc-1', 'user-1', 'motivo')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rechaza con ForbiddenException si el usuario no es firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(service.reject('doc-1', 'user-1', 'motivo')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('bug corregido: rechaza con BadRequestException si dos peticiones casi simultáneas rechazan lo mismo (carrera perdida)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      collaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.reject('doc-1', 'user-1', 'motivo')).rejects.toThrow(
        BadRequestException,
      );
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

      const result = await service.reject('doc-1', 'user-1', 'No es válido');

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

      const result = await service.requestVerificationCode(
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

      const result = await service.requestVerificationCode(
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

      const result = await service.requestVerificationCode(
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

      const result = await service.requestVerificationCode(
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
        service.requestVerificationCode('doc-1', 'user-1', '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('verifyCode consume el código cuando el usuario ya es firmante', async () => {
      collaboratorRepository.findOne.mockResolvedValue(
        buildSigner({ userId: 'user-1' }),
      );

      const result = await service.verifyCode('doc-1', 'user-1', '123456');

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

      const result = await service.verifyCode('doc-1', 'user-1', '123456');

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

      const result = await service.requestCancellation('doc-1', 'creator-1');

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

      await service.requestCancellation('doc-1', 'creator-1');

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
        service.requestCancellation('doc-1', 'otro-usuario'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rechaza con BadRequestException si el documento no está SIGNED', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.PENDING }),
      );

      await expect(
        service.requestCancellation('doc-1', 'creator-1'),
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

      const result = await service.confirmCancellation('doc-1', 'user-1');

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
        service.confirmCancellation('doc-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza con ForbiddenException si quien confirma no es firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        service.confirmCancellation('doc-1', 'user-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('bug corregido: rechaza con BadRequestException si dos firmantes confirman casi simultáneamente (carrera perdida)', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      documentRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.confirmCancellation('doc-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('lanza NotFoundException si el documento no existe', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing-doc')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // Historia "Visualización pública de documentos firmados mediante MinIO": esta ruta no tiene
  // ningún control de acceso (cualquiera con el UUID la puede llamar), así que el gate por
  // status === SIGNED es la única defensa contra exponer el archivo de un documento que no
  // debería ser público todavía.
  describe('getPublicDocumentView', () => {
    it('lanza NotFoundException si el documento no existe, sin llamar a Minio', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getPublicDocumentView('missing-doc'),
      ).rejects.toThrow(NotFoundException);
      expect(minioService.getFile).not.toHaveBeenCalled();
    });

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
        documentRepository.findOne.mockResolvedValue({
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status,
          objectKey: 'object-key-1',
        });

        const result = await service.getPublicDocumentView('doc-1');

        expect(minioService.getFile).not.toHaveBeenCalled();
        expect(result).toEqual({
          success: true,
          message: 'Documento obtenido correctamente',
          data: {
            id: 'doc-1',
            fileName: 'contrato.pdf',
            status,
            secureUrl: null,
            expiresIn: null,
          },
        });
      },
    );

    it('con status=SIGNED: genera y devuelve la URL prefirmada de Minio desde el bucket de finalizados', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
      });
      minioService.getFile.mockResolvedValue({
        secureUrl: 'https://minio/finalized-documents/object-key-1',
        expiresIn: 86400,
      });

      const result = await service.getPublicDocumentView('doc-1');

      // La vista pública comparte la versión definitiva (documento + hoja de firmas), igual que
      // el resto de las rutas de lectura.
      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
      );
      expect(result).toEqual({
        success: true,
        message: 'Documento obtenido correctamente',
        data: {
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.SIGNED,
          secureUrl: 'https://minio/finalized-documents/object-key-1',
          expiresIn: 86400,
        },
      });
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

      const result = await service.getAdvancedSignaturePublicView(
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

      const result = await service.getAdvancedSignaturePublicView(
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
        service.getAdvancedSignaturePublicView('doc-1', 'collaborator-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('responde 404 para una firma simple: su constancia es la rúbrica visible, no este QR', async () => {
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(
        advancedCollaborator({
          signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        }),
      );

      await expect(
        service.getAdvancedSignaturePublicView('doc-1', 'collaborator-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('responde 404 si el colaborador no pertenece al documento', async () => {
      collaboratorRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.getAdvancedSignaturePublicView('doc-1', 'otro-colaborador'),
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

  describe('getDocumentMinioURL: bucket según el estatus del documento', () => {
    it.each([
      // Firmado y con cancelación en curso sirven la versión definitiva (documento + hoja de
      // firmas) desde `finalized_documents` — ver historia "Anexar hoja existente...".
      [DOCUMENT_STATUS_ENUM.SIGNED, BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS],
      [
        DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
      ],
      [DOCUMENT_STATUS_ENUM.REJECTED, BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.CANCELLED, BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.CREATED, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.PENDING, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.EXPIRED, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
    ])('status=%s resuelve el bucket %s', async (status, expectedBucket) => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status,
        objectKey: 'object-key-1',
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-1',
        expectedBucket,
      );
    });

    it('nunca sirve el documento original cuando el documento ya está firmado', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).not.toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
    });

    /**
     * Historia "Actualizar el previsualizador con el avance de firmas": el estatus por sí solo no
     * alcanza para decidir qué versión sirve un documento PENDING — depende de si ya firmó
     * alguien. Es la única excepción a STATUS_BUCKET_MAP.
     */
    it.each([
      [0, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [undefined, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [1, BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS],
      [3, BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS],
    ])(
      'pendiente con completedSignersCount=%s resuelve el bucket %s',
      async (completedSignersCount, expectedBucket) => {
        documentRepository.findOne.mockResolvedValue({
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.PENDING,
          objectKey: 'object-key-1',
          completedSignersCount,
        });

        await service.getDocumentMinioURL('doc-1');

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          expectedBucket,
        );
      },
    );

    // La vista previa solo aplica mientras se está firmando: un documento ya firmado, rechazado o
    // cancelado tiene su propia versión definitiva y no debe caer nunca en el bucket de avance.
    it.each([
      DOCUMENT_STATUS_ENUM.SIGNED,
      DOCUMENT_STATUS_ENUM.REJECTED,
      DOCUMENT_STATUS_ENUM.CANCELLED,
    ])('status=%s nunca sirve la vista previa del avance', async (status) => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status,
        objectKey: 'object-key-1',
        completedSignersCount: 2,
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).not.toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS,
      );
    });
  });

  /**
   * `GET /document/file/:id` no es la única ruta que entrega el archivo: el detalle
   * (`GET /document/:id`, lo que realmente renderiza el visor de la pantalla de firma) y el
   * listado con `withUrl` traen su propio `secureUrl`. Los tres tienen que resolver el bucket
   * por el mismo STATUS_BUCKET_MAP; si alguno se quedara en el bucket original, un documento ya
   * firmado volvería a mostrarse sin firmas por esa vía aunque `getDocumentMinioURL` esté bien.
   */
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

        await service.findDetailForUser('doc-1', 'user-1');

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

      await service.findWithFilters('user-1', 'account-1', {
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

      const resultB = await service.findDetailForUser('doc-1', 'user-b');
      expect(resultB.data.canSign).toBe(true);

      const resultC = await service.findDetailForUser('doc-1', 'user-c');
      expect(resultC.data.canSign).toBe(false);
    });

    it('sign() acepta al firmante B y rechaza a C con ForbiddenException, igual que findDetailForUser', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDetailDocument() as unknown as DocumentEntity,
      );
      collaboratorRepository.find.mockResolvedValue(participants);

      await expect(
        service.sign('doc-1', 'user-c', undefined, TEST_GEOLOCATION),
      ).rejects.toThrow(ForbiddenException);

      const resultB = await service.sign(
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

      const resultC = await service.findDetailForUser('doc-1', 'user-c');
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

      const result = await service.findDetailForUser('doc-1', 'user-b');

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

      await service.findDetailForUser('doc-1', 'user-b');

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

      await expect(
        service.findDetailForUser('doc-1', 'user-x'),
      ).rejects.toThrow(ForbiddenException);
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

      const result = await service.findDetailForUser('doc-1', 'user-b');

      expect(result.data.canSign).toBe(true);
      expect(result.data.myStatus).toBe(SIGNEE_STATUS_ENUM.PENDING);
    });
  });

  describe('assertUserHasAccess (descarga del archivo)', () => {
    const document = { id: 'doc-1', createdBy: 'creator-1' } as DocumentEntity;

    it('el creador siempre tiene acceso, sin consultar colaboradores', async () => {
      documentRepository.findOne.mockResolvedValue(document);

      await expect(
        service.assertUserHasAccess('doc-1', 'creator-1'),
      ).resolves.toBe(document);
      expect(collaboratorRepository.findOne).not.toHaveBeenCalled();
    });

    it('un colaborador con cuenta vinculada tiene acceso', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'collaborator-1',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-2'),
      ).resolves.toBe(document);
    });

    it('bug corregido: un colaborador invitado solo por email también puede descargar el archivo (antes 403, con el detalle cargando y el visor vacío)', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'collaborator-1', accountId: null });
      userService.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'invitado@correo.com',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-2'),
      ).resolves.toBe(document);
    });

    it('un usuario sin relación con el documento sigue recibiendo ForbiddenException', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne.mockResolvedValue(null);
      userService.findOne.mockResolvedValue({
        id: 'user-3',
        email: 'intruso@correo.com',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-3'),
      ).rejects.toThrow(ForbiddenException);
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

      const result = await service.linkPendingCollaboratorAccount(
        'doc-1',
        'user-2',
      );

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

      const result = await service.linkPendingCollaboratorAccount(
        'doc-1',
        'user-2',
      );

      expect(result.data.linked).toBe(false);
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    });
  });
});
