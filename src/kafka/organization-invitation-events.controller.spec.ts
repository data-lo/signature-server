import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OrganizationInvitationEventsConsumer } from './organization-invitation-events.controller';
import { EmailService } from 'src/shared/email/email.service';
import type { OrganizationInvitationEventPayload } from './organization-invitation.topics';

describe('OrganizationInvitationEventsConsumer', () => {
  let consumer: OrganizationInvitationEventsConsumer;
  let emailService: { sendOrganizationInvitationNotification: jest.Mock };
  let configService: { get: jest.Mock };

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
      sendOrganizationInvitationNotification: jest.fn().mockResolvedValue(undefined),
    };
    configService = { get: jest.fn().mockReturnValue('http://localhost:3001') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationInvitationEventsConsumer,
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    consumer = module.get<OrganizationInvitationEventsConsumer>(
      OrganizationInvitationEventsConsumer,
    );
  });

  it('construye el enlace de /join con token+orgId y despacha el correo vía SendGrid', async () => {
    await consumer.handleInvited(payload);

    expect(emailService.sendOrganizationInvitationNotification).toHaveBeenCalledWith(
      'nuevo@empresa.com',
      'Acme Corp',
      'http://localhost:3001/join?token=token-1&orgId=org-1',
    );
  });

  it('usa el fallback localhost:3001 si FRONTEND_URL no está configurado', async () => {
    configService.get.mockReturnValue(undefined);

    await consumer.handleInvited(payload);

    expect(emailService.sendOrganizationInvitationNotification).toHaveBeenCalledWith(
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
