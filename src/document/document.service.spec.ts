import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParticipantEntity } from './entities/document-participant.entity';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { DOCUMENT_PARTICIPANT_ROLE_ENUM } from './enum/document-participant-role.enum';
import { DOCUMENT_PARTICIPANT_STATUS_ENUM } from './enum/document-participant-status.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { UserService } from 'src/user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => data),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function buildSigner(overrides: Partial<DocumentParticipantEntity> = {}) {
  return {
    id: overrides.id ?? 'participant-1',
    documentId: 'doc-1',
    userId: overrides.userId ?? 'user-1',
    role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER,
    status: DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
    signOrder: overrides.signOrder ?? 0,
    user: {
      id: overrides.userId ?? 'user-1',
      firstName: 'Firmante',
      lastName: 'Uno',
      email: 'firmante@correo.com',
      signatureId: 'signature-1',
    },
    ...overrides,
  } as unknown as DocumentParticipantEntity;
}

describe('DocumentService', () => {
  let service: DocumentService;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let participantRepository: ReturnType<typeof createMockRepository>;
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let userService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let signatureService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;

  beforeEach(async () => {
    documentRepository = createMockRepository();
    participantRepository = createMockRepository();
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
      sendDocumentRejectedNotification: jest.fn(),
      sendDocumentCancellationPendingNotification: jest.fn(),
      sendDocumentCancelledNotification: jest.fn(),
    };
    auditService = { create: jest.fn() };
    documentEventsProducer = {
      emitCreated: jest.fn(),
      emitSentToSign: jest.fn(),
      emitSigned: jest.fn(),
      emitRejected: jest.fn(),
      emitCancelled: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(DocumentParticipantEntity),
          useValue: participantRepository,
        },
        { provide: MinioService, useValue: minioService },
        { provide: HashService, useValue: hashService },
        { provide: UserService, useValue: userService },
        { provide: PdfSignatureService, useValue: documentSigningService },
        { provide: SignatureService, useValue: signatureService },
        { provide: EmailService, useValue: emailService },
        { provide: AuditService, useValue: auditService },
        { provide: DocumentEventsProducer, useValue: documentEventsProducer },
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

    const dto = { signerIds: ['user-1'], spectatorIds: [] } as any;

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
      participantRepository.find.mockResolvedValue([
        {
          ...buildSigner(),
          role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER,
        },
      ]);
    });

    it('crea el documento y sus participantes cuando todo es válido', async () => {
      const result = await service.create('creator-1', dto, file, '127.0.0.1');

      expect(result.success).toBe(true);
      expect(minioService.uploadObject).toHaveBeenCalled();
      expect(participantRepository.save).toHaveBeenCalled();
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'DOCUMENT_CREATED' }),
      );
      expect(documentEventsProducer.emitCreated).toHaveBeenCalled();
    });

    it('rechaza si no se proporciona archivo', async () => {
      await expect(
        service.create('creator-1', dto, undefined as any, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el mismo usuario está entre firmantes y espectadores', async () => {
      const dupDto = { signerIds: ['user-1'], spectatorIds: ['user-1'] } as any;

      await expect(
        service.create('creator-1', dupDto, file, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('rechaza si ya existe un documento propio con el mismo nombre en CREATED/PENDING', async () => {
      documentRepository.findOne.mockImplementation(async (options: any) => {
        if (options?.where?.fileName) return { id: 'existing-doc' };
        return null;
      });

      await expect(
        service.create('creator-1', dto, file, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
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
      const signerA = buildSigner({ userId: 'user-1', signOrder: 0 });
      const signerB = buildSigner({
        id: 'participant-2',
        userId: 'user-2',
        signOrder: 1,
      });
      participantRepository.find.mockResolvedValue([signerA, signerB]);
      participantRepository.findOne = jest.fn().mockResolvedValue(signerB);

      const result = await service.sign('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(participantRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DOCUMENT_PARTICIPANT_STATUS_ENUM.SIGNED,
        }),
      );
      expect(documentEventsProducer.emitSigned).not.toHaveBeenCalled();
      expect(emailService.sendDocumentPendingNotification).toHaveBeenCalled();
    });

    it('finaliza el documento (estampa y notifica a todos) cuando es el último firmante', async () => {
      const document = mockDocument();
      documentRepository.findOne.mockResolvedValue(document);
      const onlySigner = buildSigner({ userId: 'user-1', signOrder: 0 });
      participantRepository.find
        .mockResolvedValueOnce([onlySigner]) // signerParticipants en sign()
        .mockResolvedValueOnce([onlySigner]); // participantRepository.find en sendCompletionEmails

      const result = await service.sign('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(documentSigningService.mergeSignatureIntoPdf).toHaveBeenCalled();
      expect(minioService.uploadPdfAObject).toHaveBeenCalled();
      expect(documentEventsProducer.emitSigned).toHaveBeenCalled();
      expect(emailService.sendDocumentSignedNotification).toHaveBeenCalled();
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
      participantRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rechaza si el firmante ya respondió antes', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      participantRepository.find.mockResolvedValue([
        buildSigner({
          userId: 'user-1',
          status: DOCUMENT_PARTICIPANT_STATUS_ENUM.SIGNED,
        }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rechaza si aún no es el turno del firmante', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      participantRepository.find.mockResolvedValue([
        buildSigner({ id: 'p-0', userId: 'user-0', signOrder: 0 }),
        buildSigner({ id: 'p-1', userId: 'user-1', signOrder: 1 }),
      ]);

      await expect(service.sign('doc-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rechaza si el firmante no tiene credencial de firma activa', async () => {
      documentRepository.findOne.mockResolvedValue(mockDocument());
      participantRepository.find.mockResolvedValue([
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
      participantRepository.find.mockResolvedValue([
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
      participantRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(service.reject('doc-1', 'user-1', 'motivo')).rejects.toThrow(
        ForbiddenException,
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
      participantRepository.find.mockResolvedValue([
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
      participantRepository.find.mockResolvedValue([
        buildSigner({ userId: 'user-1' }),
      ]);

      const result = await service.confirmCancellation('doc-1', 'user-1');

      expect(result.success).toBe(true);
      expect(documentSigningService.stampCancelledWatermark).toHaveBeenCalled();
      expect(documentRepository.save).toHaveBeenCalledWith(
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
      participantRepository.find.mockResolvedValue([
        buildSigner({ userId: 'otro-usuario' }),
      ]);

      await expect(
        service.confirmCancellation('doc-1', 'user-1'),
      ).rejects.toThrow(ForbiddenException);
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
});
