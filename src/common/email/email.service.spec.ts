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
});
