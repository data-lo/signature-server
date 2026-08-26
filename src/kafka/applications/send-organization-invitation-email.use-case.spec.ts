import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationInvitationEventsConsumer } from '../organization-invitation-events.controller';
import { SendOrganizationInvitationEmailUseCase } from './send-organization-invitation-email.use-case';
import { EmailService } from 'src/shared/email/email.service';
import type { OrganizationInvitationEventPayload } from '../organization-invitation.topics';

describe('OrganizationInvitationEventsConsumer', () => {
  let consumer: OrganizationInvitationEventsConsumer;
  let emailService: { sendOrganizationInvitationNotification: jest.Mock };

  // La base del frontend se lee de `process.env` (vía `frontendBaseUrl`), no de ConfigService:
  // es la misma fuente normalizada que usan los enlaces de documentos y el origin de CORS.
  const originalFrontendUrl = process.env.FRONTEND_URL;

  const payload: OrganizationInvitationEventPayload = {
    eventId: 'event-1',
    email: 'nuevo@empresa.com',
    organizationId: 'org-1',
    organizationName: 'Acme Corp',
    roleId: 'role-1',
    invitationToken: 'token-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    emailService = {
      sendOrganizationInvitationNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationInvitationEventsConsumer],
      providers: [
        SendOrganizationInvitationEmailUseCase,
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    consumer = module.get<OrganizationInvitationEventsConsumer>(
      OrganizationInvitationEventsConsumer,
    );
  });

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  const joinUrlSentTo = (): string =>
    emailService.sendOrganizationInvitationNotification.mock.calls[0][2];

  it('construye el enlace de /join con token+orgId y despacha el correo vía SendGrid', async () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com';

    await consumer.handleInvited(payload);

    expect(
      emailService.sendOrganizationInvitationNotification,
    ).toHaveBeenCalledWith(
      'nuevo@empresa.com',
      'Acme Corp',
      'https://app.ejemplo.com/join?token=token-1&orgId=org-1',
    );
  });

  // Regresión: este consumer leía `FRONTEND_URL` crudo, así que una base con diagonal final
  // —lo natural de escribir en un panel de despliegue— mandaba `...//join` en el correo.
  it('normaliza la diagonal final de FRONTEND_URL: nunca manda un enlace con //', async () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com/';

    await consumer.handleInvited(payload);

    expect(joinUrlSentTo()).toBe(
      'https://app.ejemplo.com/join?token=token-1&orgId=org-1',
    );
    expect(joinUrlSentTo()).not.toContain('//join');
  });

  it('usa el fallback localhost:3001 si FRONTEND_URL no está configurado', async () => {
    delete process.env.FRONTEND_URL;

    await consumer.handleInvited(payload);

    expect(
      emailService.sendOrganizationInvitationNotification,
    ).toHaveBeenCalledWith(
      'nuevo@empresa.com',
      'Acme Corp',
      'http://localhost:3001/join?token=token-1&orgId=org-1',
    );
  });

  it('no propaga el error si SendGrid falla (el consumer nunca debe tumbarse)', async () => {
    emailService.sendOrganizationInvitationNotification.mockRejectedValue(
      new Error('SendGrid caído'),
    );

    await expect(consumer.handleInvited(payload)).resolves.toBeUndefined();
  });
});
