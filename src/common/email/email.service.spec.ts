import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

describe('EmailService', () => {
  let service: EmailService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config = {
                SENDGRID_API_KEY: 'test-api-key',
                SENDGRID_FROM_EMAIL: 'test@example.com',
                FRONTEND_URL: 'http://localhost:3000',
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw error if SENDGRID_API_KEY is not defined', () => {
    jest.spyOn(configService, 'get').mockReturnValue(undefined);

    expect(() => new EmailService(configService)).toThrow(
      'SENDGRID_API_KEY is not defined',
    );
  });

  /**
   * Historia "Corregir notificación por correo a aprobadores asignados": el correo tiene que decir
   * que hay algo pendiente de APROBAR —no de firmar— e identificar el documento y el camino para
   * llegar a él.
   */
  describe('sendDocumentApprovalRequestedNotification', () => {
    const accessUrl =
      'http://localhost:3000/access-document?docId=doc-1&collabId=reviewer-1&email=ana%40acme.mx';

    it('manda al aprobador el aviso de aprobación pendiente, con el creador como replyTo', async () => {
      const sendEmail = jest
        .spyOn(service, 'sendEmail')
        .mockResolvedValue(undefined);

      await service.sendDocumentApprovalRequestedNotification(
        'ana@acme.mx',
        'Ana López',
        'contrato.pdf',
        'Sara Ramírez',
        'sara@acme.mx',
        accessUrl,
      );

      expect(sendEmail).toHaveBeenCalledWith(
        'ana@acme.mx',
        'Tienes un documento pendiente de aprobación',
        expect.any(String),
        'NOTIFICATION',
        'sara@acme.mx',
      );

      const html = sendEmail.mock.calls[0][2] as string;
      expect(html).toContain('pendiente de aprobación');
      expect(html).toContain('Ana López');
      expect(html).toContain('contrato.pdf');
      expect(html).toContain('Sara Ramírez');
      expect(html).toContain(`href="${accessUrl}"`);
    });

    it('propaga el error de envío para que quien llama lo registre', async () => {
      jest
        .spyOn(service, 'sendEmail')
        .mockRejectedValue(new Error('Failed to send email'));

      await expect(
        service.sendDocumentApprovalRequestedNotification(
          'ana@acme.mx',
          'Ana López',
          'contrato.pdf',
          'Sara Ramírez',
          'sara@acme.mx',
          accessUrl,
        ),
      ).rejects.toThrow('Failed to send email');
    });
  });
});
