import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { describe, beforeEach, it } from 'node:test';

describe('EmailController', () => {
  let controller: EmailController;
  let emailService: EmailService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailController],
      providers: [
        {
          provide: EmailService,
          useValue: {
            sendEmail: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<EmailController>(EmailController);
    emailService = module.get<EmailService>(EmailService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should send email successfully', async () => {
    const sendEmailDto = {
      to: 'test@example.com',
      subject: 'Test Subject',
      html: '<p>Test content</p>',
      from: 'sender@example.com',
    };

    const result = await controller.sendEmail(sendEmailDto);

    expect(emailService.sendEmail).toHaveBeenCalledWith(
      sendEmailDto.to,
      sendEmailDto.subject,
      sendEmailDto.html,
      sendEmailDto.from,
    );
    expect(result).toEqual({ message: 'Email sent successfully' });
  });
});

function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}


function expect(controller: EmailController) {
  throw new Error('Function not implemented.');
}
