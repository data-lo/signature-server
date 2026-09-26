import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationEventsConsumer } from '../notification-events.controller';
import { SendPendingSignatureNotificationUseCase } from './send-pending-signature-notification.use-case';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { EmailService } from 'src/common/email/email.service';
import type { NotificationEventPayload } from '../notification-events.topics';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
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
    status: COLLABORATOR_STATUS_ENUM.PENDING,
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
  let notificationRepository: ReturnType<typeof createMockRepository>;
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
    notificationRepository = createMockRepository();
    emailService = {
      sendDocumentPendingNotification: jest.fn().mockResolvedValue(undefined),
      sendDocumentWitnessAddedNotification: jest
        .fn()
        .mockResolvedValue(undefined),
      sendDocumentApprovalRequestedNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };

    documentRepository.findOne.mockResolvedValue(buildDocument());
    userRepository.findOne.mockResolvedValue({
      id: 'creator-1',
      email: 'creador@correo.com',
      firstName: 'Creador',
      lastName: 'Uno',
    });
    collaboratorRepository.update.mockResolvedValue({ affected: 1 });
    notificationRepository.update.mockResolvedValue({ affected: 1 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationEventsConsumer],
      providers: [
        SendPendingSignatureNotificationUseCase,
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
        {
          provide: getRepositoryToken(NotificationEntity),
          useValue: notificationRepository,
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

  /**
   * Historia "Corregir notificación por correo a aprobadores asignados": el aprobador quedaba
   * asignado pero el consumidor lo dejaba caer sin correo. El aprobador se elige de los miembros
   * de la organización, así que su colaborador tiene cuenta y de ella salen nombre y correo.
   */
  describe('colaborador REVIEWER', () => {
    const reviewerPayload: NotificationEventPayload = {
      ...payload,
      notificationId: 'notification-reviewer-1',
      collaboratorId: 'reviewer-1',
      actorType: 'account',
    };

    function buildReviewer(overrides: Partial<CollaboratorEntity> = {}) {
      return buildCollaborator({
        id: 'reviewer-1',
        accountId: 'account-reviewer-1',
        email: null,
        firstName: null,
        lastName: null,
        colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
        signatureType: null,
        signingOrder: null,
        account: {
          id: 'account-reviewer-1',
          user: {
            id: 'user-reviewer-1',
            email: 'ana@acme.mx',
            firstName: 'Ana',
            lastName: 'López',
          },
        } as CollaboratorEntity['account'],
        ...overrides,
      });
    }

    beforeEach(() => {
      collaboratorRepository.findOne.mockResolvedValue(buildReviewer());
      documentRepository.findOne.mockResolvedValue(
        buildDocument({ status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL }),
      );
    });

    it('asignación inicial: envía al aprobador el correo de documento pendiente de aprobación', async () => {
      await consumer.handleCreated(reviewerPayload);

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).toHaveBeenCalledTimes(1);
      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).toHaveBeenCalledWith(
        'ana@acme.mx',
        'Ana López',
        'contrato.pdf',
        'Creador Uno',
        'creador@correo.com',
        // Mismo punto de entrada que firmantes y testigos: lleva al detalle, donde se aprueba.
        expect.stringContaining(
          '/access-document?docId=doc-1&collabId=reviewer-1',
        ),
      );
      expect(
        emailService.sendDocumentPendingNotification,
      ).not.toHaveBeenCalled();
    });

    it('marca la notificación como enviada ANTES de mandar el correo, y como entregada después', async () => {
      const calls: string[] = [];
      notificationRepository.update.mockImplementation(async (_where, set) => {
        calls.push(set.delivered ? 'delivered' : 'claim');
        return { affected: 1 };
      });
      emailService.sendDocumentApprovalRequestedNotification.mockImplementation(
        async () => {
          calls.push('email');
        },
      );

      await consumer.handleCreated(reviewerPayload);

      expect(calls).toEqual(['claim', 'email', 'delivered']);
      expect(notificationRepository.update).toHaveBeenNthCalledWith(
        1,
        { id: 'notification-reviewer-1', isNotified: false },
        { isNotified: true, sentAt: expect.any(Date) },
      );
      expect(notificationRepository.update).toHaveBeenLastCalledWith(
        { id: 'notification-reviewer-1' },
        { delivered: true },
      );
    });

    it('no toca el estatus del aprobador: tiene que seguir PENDING para poder aprobar', async () => {
      await consumer.handleCreated(reviewerPayload);

      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    });

    it('sin duplicados: si Kafka reentrega el mismo evento, el correo sale una sola vez', async () => {
      notificationRepository.update
        .mockResolvedValueOnce({ affected: 1 }) // claim de la primera entrega
        .mockResolvedValueOnce({ affected: 1 }) // delivered de la primera entrega
        .mockResolvedValueOnce({ affected: 0 }); // claim de la reentrega: ya estaba enviada

      await consumer.handleCreated(reviewerPayload);
      await consumer.handleCreated(reviewerPayload);

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).toHaveBeenCalledTimes(1);
    });

    it('si otra entrega ya ganó el claim, no envía el correo', async () => {
      notificationRepository.update.mockResolvedValue({ affected: 0 });

      await consumer.handleCreated(reviewerPayload);

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).not.toHaveBeenCalled();
    });

    it('asignación posterior: un aprobador nuevo, con su propia notificación, recibe su correo', async () => {
      await consumer.handleCreated(reviewerPayload);

      collaboratorRepository.findOne.mockResolvedValue(
        buildReviewer({
          id: 'reviewer-2',
          account: {
            id: 'account-reviewer-2',
            user: {
              id: 'user-reviewer-2',
              email: 'luis@acme.mx',
              firstName: 'Luis',
              lastName: 'Pérez',
            },
          } as CollaboratorEntity['account'],
        }),
      );
      await consumer.handleCreated({
        ...reviewerPayload,
        notificationId: 'notification-reviewer-2',
        collaboratorId: 'reviewer-2',
      });

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).toHaveBeenCalledTimes(2);
      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).toHaveBeenLastCalledWith(
        'luis@acme.mx',
        'Luis Pérez',
        'contrato.pdf',
        'Creador Uno',
        'creador@correo.com',
        expect.stringContaining('collabId=reviewer-2'),
      );
      expect(notificationRepository.update).toHaveBeenCalledWith(
        { id: 'notification-reviewer-2', isNotified: false },
        expect.objectContaining({ isNotified: true }),
      );
    });

    it('no avisa si el documento ya no espera aprobación', async () => {
      documentRepository.findOne.mockResolvedValue(
        buildDocument({ status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE }),
      );

      await consumer.handleCreated(reviewerPayload);

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).not.toHaveBeenCalled();
      expect(notificationRepository.update).not.toHaveBeenCalled();
    });

    it('no avisa a un aprobador que ya decidió', async () => {
      collaboratorRepository.findOne.mockResolvedValue(
        buildReviewer({ status: COLLABORATOR_STATUS_ENUM.APPROVED }),
      );

      await consumer.handleCreated(reviewerPayload);

      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).not.toHaveBeenCalled();
    });

    it('si el correo falla, lo registra, revierte el claim y no propaga el error', async () => {
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      emailService.sendDocumentApprovalRequestedNotification.mockRejectedValue(
        new Error('SendGrid caído'),
      );

      await expect(
        consumer.handleCreated(reviewerPayload),
      ).resolves.toBeUndefined();

      expect(notificationRepository.update).toHaveBeenLastCalledWith(
        { id: 'notification-reviewer-1', isNotified: true },
        { isNotified: false, sentAt: null },
      );
      expect(notificationRepository.update).not.toHaveBeenCalledWith(
        expect.anything(),
        { delivered: true },
      );
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('SendGrid caído'),
        expect.anything(),
      );
      logError.mockRestore();
    });

    it('mientras espera aprobación, a los firmantes no se les manda nada', async () => {
      const signer = buildCollaborator();
      collaboratorRepository.findOne.mockResolvedValue(signer);
      collaboratorRepository.find.mockResolvedValue([signer]);

      await consumer.handleCreated(payload);

      expect(
        emailService.sendDocumentPendingNotification,
      ).not.toHaveBeenCalled();
      expect(
        emailService.sendDocumentApprovalRequestedNotification,
      ).not.toHaveBeenCalled();
    });
  });

  describe('colaborador WITNESS', () => {
    function buildWitness(overrides: Partial<CollaboratorEntity> = {}) {
      return buildCollaborator({
        colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        email: 'testigo@correo.com',
        firstName: 'Testigo',
        lastName: 'Uno',
        signatureType: null,
        signingOrder: null,
        ...overrides,
      });
    }

    it('envía el correo de testigo y lo marca NOTIFIED', async () => {
      collaboratorRepository.findOne.mockResolvedValue(buildWitness());

      await consumer.handleCreated(payload);

      expect(
        emailService.sendDocumentWitnessAddedNotification,
      ).toHaveBeenCalledWith(
        'testigo@correo.com',
        'Testigo Uno',
        'contrato.pdf',
        'Creador Uno',
        'creador@correo.com',
        expect.stringContaining(
          '/access-document?docId=doc-1&collabId=collaborator-1',
        ),
      );
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        { id: 'collaborator-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
        { status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
      );
      expect(
        emailService.sendDocumentPendingNotification,
      ).not.toHaveBeenCalled();
    });

    it('ya NOTIFIED: no envía nada ni vuelve a actualizar', async () => {
      collaboratorRepository.findOne.mockResolvedValue(
        buildWitness({ status: COLLABORATOR_STATUS_ENUM.NOTIFIED }),
      );

      await consumer.handleCreated(payload);

      expect(
        emailService.sendDocumentWitnessAddedNotification,
      ).not.toHaveBeenCalled();
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    });

    /**
     * El claim va antes del envío (historia "Corregir notificaciones por correo para testigos"):
     * si el correo falla, se devuelve a PENDING para que la siguiente entrega lo reintente, y el
     * error queda registrado sin propagarse al consumidor.
     */
    it('si el correo falla, lo devuelve a PENDING para reintentarlo', async () => {
      collaboratorRepository.findOne.mockResolvedValue(buildWitness());
      emailService.sendDocumentWitnessAddedNotification.mockRejectedValue(
        new Error('SendGrid caído'),
      );

      await expect(consumer.handleCreated(payload)).resolves.toBeUndefined();

      expect(collaboratorRepository.update).toHaveBeenNthCalledWith(
        1,
        { id: 'collaborator-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
        { status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
      );
      expect(collaboratorRepository.update).toHaveBeenNthCalledWith(
        2,
        { id: 'collaborator-1', status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
        { status: COLLABORATOR_STATUS_ENUM.PENDING },
      );
    });

    /**
     * Dos entregas del mismo evento que pasan a la vez la guarda de PENDING —Kafka reentregando,
     * o el re-aviso tras la aprobación coincidiendo con el original—: sólo la que gana el claim
     * envía.
     */
    it('si otra entrega ya ganó el claim, no envía el correo', async () => {
      collaboratorRepository.findOne.mockResolvedValue(buildWitness());
      collaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await consumer.handleCreated(payload);

      expect(
        emailService.sendDocumentWitnessAddedNotification,
      ).not.toHaveBeenCalled();
    });

    it('marca NOTIFIED antes de enviar el correo', async () => {
      collaboratorRepository.findOne.mockResolvedValue(buildWitness());
      const calls: string[] = [];
      collaboratorRepository.update.mockImplementation(async () => {
        calls.push('claim');
        return { affected: 1 };
      });
      emailService.sendDocumentWitnessAddedNotification.mockImplementation(
        async () => {
          calls.push('email');
        },
      );

      await consumer.handleCreated(payload);

      expect(calls).toEqual(['claim', 'email']);
    });
  });

  it('no envía nada si el colaborador ya no está PENDING', async () => {
    collaboratorRepository.findOne.mockResolvedValue(
      buildCollaborator({ status: COLLABORATOR_STATUS_ENUM.SIGNED }),
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
