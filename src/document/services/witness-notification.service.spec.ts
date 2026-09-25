import { EmailService } from 'src/common/email/email.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';

import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { WitnessNotificationService } from './witness-notification.service';

/**
 * Historia "Corregir notificaciones por correo para testigos durante el ciclo de vida del
 * documento". Los repositorios, el productor y el correo se simulan: lo que se prueba es a quién
 * se avisa, con qué, y que un fallo no corte a los demás.
 */
describe('WitnessNotificationService', () => {
  let collaboratorRepository: { find: jest.Mock };
  let notificationRepository: { find: jest.Mock };
  let notificationEventsProducer: { emitCreated: jest.Mock };
  let emailService: { sendDocumentRejectedToWitnessNotification: jest.Mock };
  let service: WitnessNotificationService;

  function witness(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      documentId: 'doc-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      account: null,
      email: `${id}@correo.com`,
      firstName: 'Testigo',
      lastName: id,
      ...overrides,
    };
  }

  function notificationFor(collaboratorId: string) {
    return {
      id: `notification-${collaboratorId}`,
      collaboratorId,
      documentId: 'doc-1',
      actorType: 'watcher',
      notificationChannelSource: 'email',
    };
  }

  beforeEach(() => {
    collaboratorRepository = { find: jest.fn().mockResolvedValue([]) };
    notificationRepository = { find: jest.fn().mockResolvedValue([]) };
    notificationEventsProducer = { emitCreated: jest.fn() };
    emailService = {
      sendDocumentRejectedToWitnessNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    service = new WitnessNotificationService(
      collaboratorRepository as never,
      notificationRepository as never,
      notificationEventsProducer as unknown as NotificationEventsProducer,
      emailService as unknown as EmailService,
    );
  });

  describe('announcePendingWitnesses', () => {
    it('busca sólo a los testigos PENDING del documento', async () => {
      await service.announcePendingWitnesses('doc-1', 'user-reviewer');

      expect(collaboratorRepository.find).toHaveBeenCalledWith({
        where: {
          documentId: 'doc-1',
          colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
          status: COLLABORATOR_STATUS_ENUM.PENDING,
        },
      });
    });

    it('re-publica la notificación que se creó con el documento, una por testigo', async () => {
      collaboratorRepository.find.mockResolvedValue([
        witness('w1'),
        witness('w2'),
      ]);
      notificationRepository.find.mockResolvedValue([
        notificationFor('w1'),
        notificationFor('w2'),
      ]);

      const announced = await service.announcePendingWitnesses(
        'doc-1',
        'user-reviewer',
      );

      expect(announced).toBe(2);
      expect(notificationEventsProducer.emitCreated).toHaveBeenCalledWith({
        notificationId: 'notification-w1',
        documentId: 'doc-1',
        collaboratorId: 'w1',
        actorType: 'watcher',
        notificationChannelSource: 'email',
        actorUserId: 'user-reviewer',
      });
      expect(notificationEventsProducer.emitCreated).toHaveBeenCalledTimes(2);
    });

    it('sin testigos pendientes no publica nada ni consulta notificaciones', async () => {
      const announced = await service.announcePendingWitnesses(
        'doc-1',
        'user-reviewer',
      );

      expect(announced).toBe(0);
      expect(notificationRepository.find).not.toHaveBeenCalled();
      expect(notificationEventsProducer.emitCreated).not.toHaveBeenCalled();
    });

    it('salta al testigo sin notificación y sigue con los demás', async () => {
      collaboratorRepository.find.mockResolvedValue([
        witness('w1'),
        witness('w2'),
      ]);
      notificationRepository.find.mockResolvedValue([notificationFor('w2')]);

      const announced = await service.announcePendingWitnesses(
        'doc-1',
        'user-reviewer',
      );

      expect(announced).toBe(1);
      expect(notificationEventsProducer.emitCreated).toHaveBeenCalledWith(
        expect.objectContaining({ collaboratorId: 'w2' }),
      );
    });
  });

  describe('notifyWitnessesOfRejection', () => {
    const params = {
      documentId: 'doc-1',
      documentName: 'contrato.pdf',
      rejecterName: 'Juan Pérez',
      reason: 'Faltan cláusulas',
    };

    it('manda a cada testigo su correo de rechazo, a su dirección registrada', async () => {
      collaboratorRepository.find.mockResolvedValue([witness('w1')]);

      await service.notifyWitnessesOfRejection(params);

      expect(collaboratorRepository.find).toHaveBeenCalledWith({
        where: {
          documentId: 'doc-1',
          colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        },
        relations: { account: { user: true } },
      });
      expect(
        emailService.sendDocumentRejectedToWitnessNotification,
      ).toHaveBeenCalledWith(
        'w1@correo.com',
        'Testigo w1',
        'Juan Pérez',
        'contrato.pdf',
        'Faltan cláusulas',
      );
    });

    it('usa el correo de la cuenta cuando el testigo ya la vinculó', async () => {
      collaboratorRepository.find.mockResolvedValue([
        witness('w1', {
          account: {
            user: {
              firstName: 'Ana',
              lastName: 'Ruiz',
              email: 'ana@cuenta.com',
            },
          },
        }),
      ]);

      await service.notifyWitnessesOfRejection(params);

      expect(
        emailService.sendDocumentRejectedToWitnessNotification,
      ).toHaveBeenCalledWith(
        'ana@cuenta.com',
        'Ana Ruiz',
        'Juan Pérez',
        'contrato.pdf',
        'Faltan cláusulas',
      );
    });

    it('no repite el correo a la misma dirección', async () => {
      collaboratorRepository.find.mockResolvedValue([
        witness('w1', { email: 'ana@correo.com' }),
        witness('w2', { email: 'ANA@correo.com' }),
      ]);

      await service.notifyWitnessesOfRejection(params);

      expect(
        emailService.sendDocumentRejectedToWitnessNotification,
      ).toHaveBeenCalledTimes(1);
    });

    it('un envío fallido no impide los demás ni lanza', async () => {
      collaboratorRepository.find.mockResolvedValue([
        witness('w1'),
        witness('w2'),
      ]);
      emailService.sendDocumentRejectedToWitnessNotification.mockImplementation(
        async (to: string) => {
          if (to === 'w1@correo.com') throw new Error('SendGrid caído');
        },
      );

      await expect(
        service.notifyWitnessesOfRejection(params),
      ).resolves.toBeUndefined();
      expect(
        emailService.sendDocumentRejectedToWitnessNotification,
      ).toHaveBeenCalledWith(
        'w2@correo.com',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
