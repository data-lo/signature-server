import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationEventsConsumer } from './notification-events.controller';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { EmailService } from 'src/shared/email/email.service';
import type { NotificationEventPayload } from './notification-events.topics';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

function buildCollaborator(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'collaborator-1',
    documentId: 'doc-1',
    accountId: null,
    email: 'firmante@correo.com',
    firstName: 'Firmante',
    lastName: 'Uno',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    signingOrder: 0,
    ...overrides,
  } as CollaboratorEntity;
}

function buildDocument(overrides: Partial<DocumentEntity> = {}) {
  return {
    id: 'doc-1',
    fileName: 'contrato.pdf',
    createdBy: 'creator-1',
    isSequential: true,
    ...overrides,
  } as DocumentEntity;
}

describe('NotificationEventsConsumer', () => {
  let consumer: NotificationEventsConsumer;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let emailService: Record<string, jest.Mock>;

  const payload: NotificationEventPayload = {
    notificationId: 'notification-1',
    documentId: 'doc-1',
    collaboratorId: 'collaborator-1',
    actorType: 'watcher',
    notificationChannelSource: 'email',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    collaboratorRepository = createMockRepository();
    documentRepository = createMockRepository();
    userRepository = createMockRepository();
    emailService = {
      sendDocumentPendingNotification: jest.fn().mockResolvedValue(undefined),
    };

    documentRepository.findOne.mockResolvedValue(buildDocument());
    userRepository.findOne.mockResolvedValue({
      id: 'creator-1',
      email: 'creador@correo.com',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEventsConsumer,
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
        },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    consumer = module.get<NotificationEventsConsumer>(
      NotificationEventsConsumer,
    );
  });

  it('should be defined', () => {
    expect(consumer).toBeDefined();
  });

  it('documento secuencial: envía el correo al único firmante pendiente', async () => {
    const signer = buildCollaborator();
    collaboratorRepository.findOne.mockResolvedValue(signer);
    collaboratorRepository.find.mockResolvedValue([signer]);

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).toHaveBeenCalledWith(
      'firmante@correo.com',
      'Firmante Uno',
      'creador@correo.com',
      'contrato.pdf',
      // El enlace debe entrar por /access-document (no por /documents/:id, que se pierde en el
      // redirect a /login cuando el destinatario abre el correo sin sesión).
      expect.stringContaining(
        '/access-document?docId=doc-1&collabId=collaborator-1',
      ),
      expect.stringContaining('/dashboard/documents'),
    );
  });

  it('documento secuencial: NO envía el correo a un firmante que no es el siguiente pendiente', async () => {
    const firstSigner = buildCollaborator({
      id: 'collaborator-0',
      signingOrder: 0,
    });
    const thisSigner = buildCollaborator({
      id: 'collaborator-1',
      signingOrder: 1,
    });
    collaboratorRepository.findOne.mockResolvedValue(thisSigner);
    collaboratorRepository.find.mockResolvedValue([firstSigner, thisSigner]);

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('documento sin orden (isSequential:false): envía el correo aunque no sea el primero en signingOrder', async () => {
    documentRepository.findOne.mockResolvedValue(
      buildDocument({ isSequential: false }),
    );
    const signer = buildCollaborator({ signingOrder: 5 });
    collaboratorRepository.findOne.mockResolvedValue(signer);

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).toHaveBeenCalled();
    // No debería necesitar cargar a todos los firmantes para decidir (solo aplica al caso secuencial).
    expect(collaboratorRepository.find).not.toHaveBeenCalled();
  });

  it('documento sin orden + firmante SIMPLE: NO envía este correo (ya recibió la invitación dedicada)', async () => {
    documentRepository.findOne.mockResolvedValue(
      buildDocument({ isSequential: false }),
    );
    const signer = buildCollaborator({
      signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
    });
    collaboratorRepository.findOne.mockResolvedValue(signer);

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('no envía nada para un colaborador WATCHER', async () => {
    collaboratorRepository.findOne.mockResolvedValue(
      buildCollaborator({ colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER }),
    );

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('no envía nada si el colaborador ya no está PENDING', async () => {
    collaboratorRepository.findOne.mockResolvedValue(
      buildCollaborator({ status: SIGNEE_STATUS_ENUM.SIGNED }),
    );

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('no envía nada si el colaborador no existe', async () => {
    collaboratorRepository.findOne.mockResolvedValue(null);

    await consumer.handleCreated(payload);

    expect(documentRepository.findOne).not.toHaveBeenCalled();
    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('no envía nada si el documento no existe', async () => {
    const signer = buildCollaborator();
    collaboratorRepository.findOne.mockResolvedValue(signer);
    documentRepository.findOne.mockResolvedValue(null);

    await consumer.handleCreated(payload);

    expect(emailService.sendDocumentPendingNotification).not.toHaveBeenCalled();
  });

  it('no propaga el error si falla el envío del correo', async () => {
    const signer = buildCollaborator();
    collaboratorRepository.findOne.mockResolvedValue(signer);
    collaboratorRepository.find.mockResolvedValue([signer]);
    emailService.sendDocumentPendingNotification.mockRejectedValue(
      new Error('SendGrid caído'),
    );

    await expect(consumer.handleCreated(payload)).resolves.toBeUndefined();
  });
});
