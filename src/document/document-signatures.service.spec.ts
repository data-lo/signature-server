import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DocumentSignaturesService } from './document-signatures.service';
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { NotificationEntity } from './entities/notification.entity';
import { SimpleSignatureEntity } from 'src/signature/entities/simple-signature.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from './verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { EmailService } from 'src/shared/email/email.service';
import { DocumentTransactionService } from './document-transaction.service';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
} from './dto/create-document-signatures.dto';

function createMockRepository() {
  let seq = 0;
  return {
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn(async (entity) => ({
      id: entity.id ?? `id-${++seq}`,
      ...entity,
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

describe('DocumentSignaturesService', () => {
  let service: DocumentSignaturesService;
  let documentRepo: ReturnType<typeof createMockRepository>;
  let collaboratorRepo: ReturnType<typeof createMockRepository>;
  let notificationRepo: ReturnType<typeof createMockRepository>;
  let simpleSignatureRepo: ReturnType<typeof createMockRepository>;
  let dataSource: { transaction: jest.Mock };
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let accountMemberService: Record<string, jest.Mock>;
  let verificationCodeService: Record<string, jest.Mock>;
  let notificationEventsProducer: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let documentTransactionService: Record<string, jest.Mock>;

  const file = {
    buffer: Buffer.from('%PDF-1.4'),
    originalname: 'contrato.pdf',
    mimetype: 'application/pdf',
    size: 1024,
  } as Express.Multer.File;

  const baseDto: CreateDocumentSignaturesDto = {
    documentData: { fileName: 'contrato_prestacion_servicios.pdf' },
    collaborators: [
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan.perez@mail.com',
        rfc: 'PEAJ800101XXX',
        signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
        signaturePosition: { page: 1, x: 150, y: 600 },
        requiresTwoFactorAuth: true,
      },
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
        firstName: 'María',
        lastName: 'Gómez',
        email: 'maria.gomez@mail.com',
        rfc: null,
        signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
        signaturePosition: { page: 1, x: 100, y: 100 },
        requiresTwoFactorAuth: false, // el backend debe forzarlo a true de todos modos (SIMPLE)
      },
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER,
        firstName: 'Carlos',
        lastName: 'Solares',
        email: 'auditor@mail.com',
        rfc: 'AUDI990101YYY',
      },
    ],
  };

  beforeEach(async () => {
    documentRepo = createMockRepository();
    collaboratorRepo = createMockRepository();
    notificationRepo = createMockRepository();
    simpleSignatureRepo = createMockRepository();

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === DocumentEntity) return documentRepo;
        if (entity === CollaboratorEntity) return collaboratorRepo;
        if (entity === NotificationEntity) return notificationRepo;
        if (entity === SimpleSignatureEntity) return simpleSignatureRepo;
        throw new Error('repositorio no mockeado');
      }),
    };

    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };

    minioService = {
      uploadObject: jest.fn().mockResolvedValue({
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: 'object-key-1.pdf',
      }),
    };
    hashService = { generateFileHash: jest.fn().mockResolvedValue('hash-123') };
    documentSigningService = { getPdfPages: jest.fn().mockResolvedValue(3) };
    accountMemberService = {
      assertIsActiveMember: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', organizationId: null }),
    };
    verificationCodeService = {
      issue: jest.fn().mockResolvedValue({ id: 'vc-1' }),
    };
    notificationEventsProducer = { emitCreated: jest.fn() };
    documentEventsProducer = { emitCreated: jest.fn() };
    emailService = {
      sendDocumentInvitationNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    documentTransactionService = { createInitial: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentSignaturesService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: MinioService, useValue: minioService },
        { provide: HashService, useValue: hashService },
        { provide: PdfSignatureService, useValue: documentSigningService },
        { provide: AccountMemberService, useValue: accountMemberService },
        { provide: VerificationCodeService, useValue: verificationCodeService },
        {
          provide: NotificationEventsProducer,
          useValue: notificationEventsProducer,
        },
        {
          provide: DocumentEventsProducer,
          useValue: documentEventsProducer,
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: DocumentTransactionService,
          useValue: documentTransactionService,
        },
      ],
    }).compile();

    service = module.get<DocumentSignaturesService>(DocumentSignaturesService);
  });

  it('Escenario 1: crea Document + N Collaborators + N Notifications + verification_code y publica N eventos Kafka', async () => {
    const result = await service.create(
      'creator-1',
      'account-1',
      baseDto,
      file,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(DOCUMENT_STATUS_ENUM.PENDING);
    expect(minioService.uploadObject).toHaveBeenCalled();
    // 2 signers + 1 viewer = 3 colaboradores/notificaciones
    expect(collaboratorRepo.save).toHaveBeenCalledTimes(3);
    expect(notificationRepo.save).toHaveBeenCalledTimes(3);
    expect(result.data.collaboratorsCount).toBe(3);
    // ADVANCED (explícito true) + SIMPLE (forzado true) = 2 verification_codes
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(2);
    expect(result.data.verificationCodesCount).toBe(2);
    expect(documentRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresVerification: true }),
    );
    expect(notificationEventsProducer.emitCreated).toHaveBeenCalledTimes(3);
    expect(documentEventsProducer.emitCreated).toHaveBeenCalledTimes(1);
    expect(documentEventsProducer.emitCreated).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'creator-1' }),
    );
    expect(documentTransactionService.createInitial).toHaveBeenCalledWith(
      expect.any(String),
      'hash-123',
      expect.anything(),
    );
  });

  it('SIMPLE fuerza verification_code aunque el payload mande requiresTwoFactorAuth:false', async () => {
    const dtoSoloSimpleSinFlag: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: [
        {
          ...baseDto.collaborators[1], // María, SIMPLE, requiresTwoFactorAuth: false
        },
      ],
    };

    await service.create(
      'creator-1',
      'account-1',
      dtoSoloSimpleSinFlag,
      file,
      '127.0.0.1',
    );

    expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
  });

  it('bug corregido: asigna signingOrder consecutivo (0,1,2...) solo entre los SIGNER, en el orden del payload; VIEWER queda en null', async () => {
    await service.create('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    const juanCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'juan.perez@mail.com',
    );
    const mariaCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'maria.gomez@mail.com',
    );
    const carlosCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'auditor@mail.com',
    );

    expect(juanCall[0].signingOrder).toBe(0);
    expect(mariaCall[0].signingOrder).toBe(1);
    expect(carlosCall[0].signingOrder).toBeNull();
  });

  it('documento secuencial (default, sin isSequential en el payload): no envía invitaciones de firma simple', async () => {
    await service.create('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    expect(
      emailService.sendDocumentInvitationNotification,
    ).not.toHaveBeenCalled();
    const savedDocumentCall = documentRepo.save.mock.calls[0][0];
    expect(savedDocumentCall.isSequential).toBe(true);
  });

  it('documento sin orden (isSequential:false): invita por correo solo a los firmantes SIMPLE, no a ADVANCED ni al viewer', async () => {
    const dtoSinOrden: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, isSequential: false },
    };

    await service.create(
      'creator-1',
      'account-1',
      dtoSinOrden,
      file,
      '127.0.0.1',
    );

    const savedDocumentCall = documentRepo.save.mock.calls[0][0];
    expect(savedDocumentCall.isSequential).toBe(false);
    expect(
      emailService.sendDocumentInvitationNotification,
    ).toHaveBeenCalledTimes(1);
    expect(
      emailService.sendDocumentInvitationNotification,
    ).toHaveBeenCalledWith(
      'maria.gomez@mail.com',
      'María Gómez',
      dtoSinOrden.documentData.fileName,
      expect.stringContaining('/access-document?docId='),
    );
  });

  it('un fallo al enviar la invitación no tumba la creación del documento', async () => {
    emailService.sendDocumentInvitationNotification.mockRejectedValue(
      new Error('SendGrid caído'),
    );
    const dtoSinOrden: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, isSequential: false },
    };

    const result = await service.create(
      'creator-1',
      'account-1',
      dtoSinOrden,
      file,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
  });

  it('el viewer se crea con colaboratorType WATCHER, sin signatureType ni verification_code', async () => {
    await service.create('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    const viewerCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'auditor@mail.com',
    );
    expect(viewerCall[0].colaboratorType).toBe(COLABORATOR_TYPE_ENUM.WATCHER);
    expect(viewerCall[0].signatureType).toBeNull();
    expect(viewerCall[0].rfc).toBe('AUDI990101YYY');
    // Solo 2 verification_codes en total (los 2 signers), ninguno para el viewer.
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(2);
  });

  it('crea una SimpleSignatureEntity por firmante con las coordenadas del payload', async () => {
    await service.create('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    expect(simpleSignatureRepo.save).toHaveBeenCalledTimes(2);
    expect(simpleSignatureRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        signatureCoordinates: expect.objectContaining({
          x: 150,
          y: 600,
          page: 1,
        }),
      }),
    );
  });

  it('Escenario 2: si falla la inserción dentro de la transacción, no se publica ningún evento a Kafka', async () => {
    collaboratorRepo.save.mockRejectedValueOnce(new Error('DB caída'));

    await expect(
      service.create('creator-1', 'account-1', baseDto, file, '127.0.0.1'),
    ).rejects.toThrow('DB caída');

    expect(notificationEventsProducer.emitCreated).not.toHaveBeenCalled();
    expect(documentEventsProducer.emitCreated).not.toHaveBeenCalled();
  });

  it('rechaza con BadRequestException si no se proporciona archivo', async () => {
    await expect(
      service.create(
        'creator-1',
        'account-1',
        baseDto,
        undefined as unknown as Express.Multer.File,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(minioService.uploadObject).not.toHaveBeenCalled();
  });

  it('rechaza con BadRequestException si falta el header X-Account-Id', async () => {
    await expect(
      service.create(
        'creator-1',
        undefined as unknown as string,
        baseDto,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(accountMemberService.assertIsActiveMember).not.toHaveBeenCalled();
  });

  it('documentData.requiresApproval se guarda en el documento', async () => {
    const dtoConAprobacion: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, requiresApproval: true },
    };

    await service.create(
      'creator-1',
      'account-1',
      dtoConAprobacion,
      file,
      '127.0.0.1',
    );

    expect(documentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval: true }),
    );
  });
});
