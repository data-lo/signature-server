import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
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
      addSignerName: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampRejectedWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampCancelledWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      // Página de prueba fija de 600x800pt — suficiente para verificar que la conversión
      // ratio→puntos y el pageIndex correcto llegan a mergeSignatureIntoPdf/addSignerName sin
      // necesitar un PDF real (eso ya lo cubre document-signing.service.spec.ts).
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

      const result = await service.sign('doc-1', 'user-1');

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

    it('bug corregido: rechaza con BadRequestException si dos peticiones casi simultáneas firman lo mismo (carrera perdida)', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find.mockResolvedValue([onlySigner]);
      collaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
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

      const result = await service.sign('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalled();
      expect(minioService.uploadPdfAObject).toHaveBeenCalled();
      expect(documentEventsProducer.emitSigned).toHaveBeenCalled();
      expect(emailService.sendDocumentSignedNotification).toHaveBeenCalled();
      expect(document.completedSignersCount).toBe(1);
    });

    it('bug corregido: además de a los participantes, notifica por correo a quien creó el documento con la lista de firmantes, ya que el creador no siempre es también un participante', async () => {
      const document = mockDocument({ createdBy: 'creator-1' });
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signingOrder: 0 });
      collaboratorRepository.find
        .mockResolvedValueOnce([onlySigner])
        .mockResolvedValueOnce([onlySigner]);

      await service.sign('doc-1', 'user-1');

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

      await service.sign('doc-1', 'user-1');

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

      await service.sign('doc-1', 'user-b');

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

      await service.sign('doc-1', 'user-1');

      expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { x: 50, y: 200, width: 100, height: 80 },
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

      await service.sign('doc-1', 'user-b');

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

      await service.sign('doc-1', 'user-1');

      expect(documentSigningService.resolveRatioPosition).toHaveBeenCalledTimes(
        2,
      );
      const mergeCalls =
        documentSigningService.mergeSignatureIntoPdf.mock.calls;
      expect(mergeCalls).toHaveLength(2);
      expect(mergeCalls[0][3]).toBe(0); // page 1 → pageIndex 0
      expect(mergeCalls[1][3]).toBe(2); // page 3 → pageIndex 2
      const addNameCalls = documentSigningService.addSignerName.mock.calls;
      expect(addNameCalls[0][3]).toBe(0);
      expect(addNameCalls[1][3]).toBe(2);
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

      const result = await service.sign('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(
        documentSigningService.mergeSignatureIntoPdf,
      ).not.toHaveBeenCalled();
      expect(documentSigningService.addSignerName).not.toHaveBeenCalled();
      // Sigue subiendo el PDF (sin cambios visuales) y marcando el documento como firmado.
      expect(minioService.uploadPdfAObject).toHaveBeenCalled();
      expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
    });

    it('rechaza si el documento no está en estatus PENDING', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ status: DOCUMENT_STATUS_ENUM.CREATED }),
      );

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rechaza si el usuario no es firmante del documento', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rechaza si el firmante ya respondió antes', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({
          userId: 'user-1',
          status: SIGNEE_STATUS_ENUM.SIGNED,
        }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rechaza si aún no es el turno del firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ id: 'p-0', userId: 'user-0', signingOrder: 0 }),
        buildSigner({ id: 'p-1', userId: 'user-1', signingOrder: 1 }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
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

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rechaza si el documento requiere verificación y el firmante no ha validado su código (Fase 7)', async () => {
      documentRepository.findOne.mockResolvedValue(
        mockDocument({ requiresVerification: true } as any),
      );
      collaboratorRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);
      verificationCodeService.hasConsumedCode.mockResolvedValue(false);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
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

      const result = await service.sign('doc-1', 'user-1');

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

      const result = await service.sign('doc-1', 'user-1');

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

      const result = await service.sign('doc-1', 'user-b');

      expect(result.success).toBe(true);
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

      await service.sign('doc-1', 'user-1', geolocation);

      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ geoLoc: geolocation }),
      );
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ geolocation }),
      );
    });

    it('permite firmar sin geolocalización (permiso rechazado o no disponible) sin bloquear la firma', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const signerA = buildSigner({ userId: 'user-1', signingOrder: 0 });
      const signerB = buildSigner({
        id: 'collaborator-2',
        userId: 'user-2',
        signingOrder: 1,
      });
      collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

      const result = await service.sign('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(collaboratorRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ geoLoc: null }),
      );
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ geolocation: undefined }),
      );
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

    it('con status=SIGNED: genera y devuelve la URL prefirmada de Minio desde el bucket de firmados', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
      });
      minioService.getFile.mockResolvedValue({
        secureUrl: 'https://minio/signed-documents/object-key-1',
        expiresIn: 86400,
      });

      const result = await service.getPublicDocumentView('doc-1');

      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
      );
      expect(result).toEqual({
        success: true,
        message: 'Documento obtenido correctamente',
        data: {
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.SIGNED,
          secureUrl: 'https://minio/signed-documents/object-key-1',
          expiresIn: 86400,
        },
      });
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

      await expect(service.sign('doc-1', 'user-c')).rejects.toThrow(
        ForbiddenException,
      );

      const resultB = await service.sign('doc-1', 'user-b');
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

    it('bug corregido (ver historia "Vinculación del documento debe postergarse hasta el inicio de sesión y validación de RFC"): findDetailForUser YA NO vincula por email como efecto secundario de una lectura — si el colaborador pendiente todavía no tiene accountId, lanza ForbiddenException en vez de auto-vincular y dejarlo pasar', async () => {
      const pendingCollaborator = buildSigner({
        id: 'p-b',
        userId: 'user-b',
        signingOrder: 1,
      });
      const unlinkedDetailDocument = {
        ...mockDetailDocument(),
        collaborators: [
          signerA,
          { ...pendingCollaborator, accountId: null, account: null },
          signerC,
        ],
      };

      documentRepository.findOne.mockResolvedValue(
        unlinkedDetailDocument as unknown as DocumentEntity,
      );

      await expect(
        service.findDetailForUser('doc-1', 'user-b'),
      ).rejects.toThrow(ForbiddenException);
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
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
