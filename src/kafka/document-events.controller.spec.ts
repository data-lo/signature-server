import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentEventsConsumer } from './document-events.controller';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { ACTOR_TYPE_ENUM } from 'src/document/enum/actor-type.enum';
import { DocumentTransactionService } from 'src/document/document-transaction.service';
import { AuditChainService } from 'src/audit-chain/audit-chain.service';
import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';
import type {
  DocumentEventPayload,
  DocumentCollaboratorSignedPayload,
} from './document-events.topics';

function createMockRepository() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(),
  };
}

function buildCollaborator(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'collaborator-1',
    documentId: 'doc-1',
    accountId: 'account-1',
    email: null,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: 0,
    ...overrides,
  } as CollaboratorEntity;
}

describe('DocumentEventsConsumer', () => {
  let consumer: DocumentEventsConsumer;
  let notificationRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let documentTransactionService: Record<string, jest.Mock>;
  let auditChainService: Record<string, jest.Mock>;

  const payload: DocumentEventPayload = {
    documentId: 'doc-1',
    fileName: 'contrato.pdf',
    actorUserId: 'user-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  const collaboratorSignedPayload: DocumentCollaboratorSignedPayload = {
    ...payload,
    collaboratorId: 'collaborator-1',
    signedAt: '2026-01-01T00:05:00.000Z',
  };

  beforeEach(async () => {
    notificationRepository = createMockRepository();
    collaboratorRepository = createMockRepository();
    documentRepository = createMockRepository();
    documentRepository.findOne.mockResolvedValue({
      id: 'doc-1',
      signedHash: 'hash-del-pdf-final',
    });
    documentTransactionService = {
      registerSignature: jest.fn(),
      registerCompletion: jest.fn(),
    };
    auditChainService = { recordEvent: jest.fn() };

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
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: DocumentTransactionService,
          useValue: documentTransactionService,
        },
        { provide: AuditChainService, useValue: auditChainService },
      ],
    }).compile();

    consumer = module.get<DocumentEventsConsumer>(DocumentEventsConsumer);
  });

  it('should be defined', () => {
    expect(consumer).toBeDefined();
  });

  it('handleCreated no escribe ninguna notificación (no se envía correo al crear), pero sí encadena el evento en el ledger global', async () => {
    await consumer.handleCreated(payload);

    expect(collaboratorRepository.find).not.toHaveBeenCalled();
    expect(notificationRepository.save).not.toHaveBeenCalled();
    expect(auditChainService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        auditType: AUDIT_TYPE_ENUM.CREATED,
      }),
    );
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
    expect(auditChainService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ auditType: AUDIT_TYPE_ENUM.PENDING }),
    );
  });

  it('handleSigned notifica a todos los colaboradores del documento', async () => {
    const collaborators = [
      buildCollaborator({ id: 'p-a' }),
      buildCollaborator({
        id: 'p-b',
        colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
        accountId: null,
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
    expect(auditChainService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: AUDIT_TYPE_ENUM.SIGNATURES_COMPLETED,
      }),
    );
  });

  it('handleRejected notifica al creador sin collaboratorId', async () => {
    await consumer.handleRejected(payload);

    expect(notificationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ collaboratorId: null, documentId: 'doc-1' }),
    );
    expect(auditChainService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ auditType: AUDIT_TYPE_ENUM.REJECTED }),
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

  describe('encadenamiento de Document Transaction según el tipo de firma', () => {
    const signed = SIGNEE_STATUS_ENUM.SIGNED;
    const pending = SIGNEE_STATUS_ENUM.PENDING;

    it('firma simple: cada firma encadena su propio registro', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({ id: 'collaborator-1', status: signed }),
        buildCollaborator({ id: 'collaborator-2', status: pending }),
      ]);

      await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

      expect(documentTransactionService.registerSignature).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        '2026-01-01T00:05:00.000Z',
      );
    });

    it('firma avanzada: una firma intermedia no genera ningún registro', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({
          id: 'collaborator-1',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          status: signed,
        }),
        buildCollaborator({
          id: 'collaborator-2',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          status: pending,
        }),
      ]);

      await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

      expect(
        documentTransactionService.registerSignature,
      ).not.toHaveBeenCalled();
      expect(
        documentTransactionService.registerCompletion,
      ).not.toHaveBeenCalled();
    });

    it('firma avanzada: la última firma cierra la cadena con el registro final, ligado al hash del PDF firmado', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({
          id: 'collaborator-1',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          status: signed,
        }),
        buildCollaborator({
          id: 'collaborator-2',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          status: signed,
        }),
      ]);

      await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

      expect(
        documentTransactionService.registerSignature,
      ).not.toHaveBeenCalled();
      expect(
        documentTransactionService.registerCompletion,
      ).toHaveBeenCalledWith('doc-1', 'hash-del-pdf-final');
    });

    it('documento de pura firma simple: al completarse NO agrega registro final (la última firma ya dejó el suyo)', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({ id: 'collaborator-1', status: signed }),
        buildCollaborator({ id: 'collaborator-2', status: signed }),
      ]);

      await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

      expect(documentTransactionService.registerSignature).toHaveBeenCalled();
      expect(
        documentTransactionService.registerCompletion,
      ).not.toHaveBeenCalled();
    });

    it('documento mixto: la firma simple encadena su registro y el documento se cierra con el final por la firma avanzada', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({ id: 'collaborator-1', status: signed }),
        buildCollaborator({
          id: 'collaborator-2',
          signatureType: SIGNATURE_TYPE_ENUM.FIEL,
          status: signed,
        }),
      ]);

      await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

      expect(documentTransactionService.registerSignature).toHaveBeenCalledWith(
        'doc-1',
        'collaborator-1',
        '2026-01-01T00:05:00.000Z',
      );
      expect(
        documentTransactionService.registerCompletion,
      ).toHaveBeenCalledWith('doc-1', 'hash-del-pdf-final');
    });

    it('no propaga el error si falla el encadenamiento de la transacción', async () => {
      collaboratorRepository.find.mockResolvedValue([
        buildCollaborator({ id: 'collaborator-1', status: signed }),
      ]);
      documentTransactionService.registerSignature.mockRejectedValue(
        new Error('DB caída'),
      );

      await expect(
        consumer.handleCollaboratorSigned(collaboratorSignedPayload),
      ).resolves.toBeUndefined();
    });
  });

  it('handleCollaboratorSigned encadena el evento en el ledger global como SIGNATURES_PARTIAL, incluyendo el collaboratorId en los metadatos', async () => {
    await consumer.handleCollaboratorSigned(collaboratorSignedPayload);

    expect(auditChainService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        auditType: AUDIT_TYPE_ENUM.SIGNATURES_PARTIAL,
        metadata: expect.objectContaining({ collaboratorId: 'collaborator-1' }),
      }),
    );
  });

  it('handleCancellationRequested/handleCancelled no encadenan nada en el ledger global (sin AUDIT_TYPE equivalente)', async () => {
    collaboratorRepository.find.mockResolvedValue([]);

    await consumer.handleCancellationRequested(payload);
    await consumer.handleCancelled(payload);

    expect(auditChainService.recordEvent).not.toHaveBeenCalled();
  });

  it('no propaga el error si falla el encadenamiento del ledger global de auditoría', async () => {
    auditChainService.recordEvent.mockRejectedValue(new Error('DB caída'));

    await expect(consumer.handleCreated(payload)).resolves.toBeUndefined();
  });
});
