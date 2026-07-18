import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentEventsConsumer } from './document-events.controller';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { ACTOR_TYPE_ENUM } from 'src/document/enum/actor-type.enum';
import type { DocumentEventPayload } from './document-events.topics';

function createMockRepository() {
  return {
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(),
  };
}

function buildCollaborator(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'collaborator-1',
    documentId: 'doc-1',
    userId: 'user-1',
    email: null,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: 0,
    ...overrides,
  } as CollaboratorEntity;
}

describe('DocumentEventsConsumer', () => {
  let consumer: DocumentEventsConsumer;
  let notificationRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;

  const payload: DocumentEventPayload = {
    documentId: 'doc-1',
    fileName: 'contrato.pdf',
    actorUserId: 'user-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    notificationRepository = createMockRepository();
    collaboratorRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentEventsConsumer,
        {
          provide: getRepositoryToken(NotificationEntity),
          useValue: notificationRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
      ],
    }).compile();

    consumer = module.get<DocumentEventsConsumer>(DocumentEventsConsumer);
  });

  it('should be defined', () => {
    expect(consumer).toBeDefined();
  });

  it('handleCreated no escribe ninguna notificación (no se envía correo al crear)', async () => {
    consumer.handleCreated(payload);

    expect(collaboratorRepository.find).not.toHaveBeenCalled();
    expect(notificationRepository.save).not.toHaveBeenCalled();
  });

  it('handleSentToSign notifica solo al próximo firmante pendiente', async () => {
    const signerA = buildCollaborator({
      id: 'p-a',
      signingOrder: 0,
      status: SIGNEE_STATUS_ENUM.SIGNED,
    });
    const signerB = buildCollaborator({ id: 'p-b', signingOrder: 1 });
    collaboratorRepository.find.mockResolvedValue([signerA, signerB]);

    await consumer.handleSentToSign(payload);

    expect(notificationRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ collaboratorId: 'p-b', documentId: 'doc-1' }),
    ]);
  });

  it('handleSigned notifica a todos los colaboradores del documento', async () => {
    const collaborators = [
      buildCollaborator({ id: 'p-a' }),
      buildCollaborator({
        id: 'p-b',
        colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
        userId: null,
        email: 'watcher@correo.com',
      }),
    ];
    collaboratorRepository.find.mockResolvedValue(collaborators);

    await consumer.handleSigned(payload);

    expect(notificationRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        collaboratorId: 'p-a',
        actorType: ACTOR_TYPE_ENUM.ACCOUNT,
      }),
      expect.objectContaining({
        collaboratorId: 'p-b',
        actorType: ACTOR_TYPE_ENUM.WATCHER,
      }),
    ]);
  });

  it('handleRejected notifica al creador sin collaboratorId', async () => {
    await consumer.handleRejected(payload);

    expect(notificationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ collaboratorId: null, documentId: 'doc-1' }),
    );
  });

  it('handleCancellationRequested notifica solo a los firmantes', async () => {
    const signers = [buildCollaborator({ id: 'p-a' })];
    collaboratorRepository.find.mockResolvedValue(signers);

    await consumer.handleCancellationRequested(payload);

    expect(collaboratorRepository.find).toHaveBeenCalledWith({
      where: {
        documentId: 'doc-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
    });
    expect(notificationRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ collaboratorId: 'p-a' }),
    ]);
  });

  it('handleCancelled notifica a todos los colaboradores', async () => {
    const collaborators = [buildCollaborator({ id: 'p-a' })];
    collaboratorRepository.find.mockResolvedValue(collaborators);

    await consumer.handleCancelled(payload);

    expect(notificationRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ collaboratorId: 'p-a' }),
    ]);
  });

  it('no propaga el error si falla la persistencia de notificaciones', async () => {
    collaboratorRepository.find.mockRejectedValue(new Error('DB caída'));

    await expect(consumer.handleSigned(payload)).resolves.toBeUndefined();
  });
});
