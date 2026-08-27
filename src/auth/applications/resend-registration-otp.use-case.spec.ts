import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { EmailService } from 'src/shared/email/email.service';
import { EmailVerificationCodeService } from 'src/user/email-verification-code.service';
import { UserService } from 'src/user/user.service';

import { ResendRegistrationOtpUseCase } from './resend-registration-otp.use-case';

describe('ResendRegistrationOtpUseCase', () => {
  let useCase: ResendRegistrationOtpUseCase;
  let userService: { findOneByEmail: jest.Mock };
  let emailVerificationCodeService: { issue: jest.Mock };
  let emailService: { sendRegistrationOtpNotification: jest.Mock };

  const dto = { email: 'ANA@empresa.com' };
  const user = {
    id: 'user-1',
    email: 'ana@empresa.com',
    isEmailVerified: false,
  };

  beforeEach(async () => {
    userService = { findOneByEmail: jest.fn().mockResolvedValue(user) };
    emailVerificationCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
    };
    emailService = {
      sendRegistrationOtpNotification: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResendRegistrationOtpUseCase,
        { provide: UserService, useValue: userService },
        {
          provide: EmailVerificationCodeService,
          useValue: emailVerificationCodeService,
        },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    useCase = module.get(ResendRegistrationOtpUseCase);
  });

  it('emite un nuevo OTP y lo envia al correo del pre-registro', async () => {
    const result = await useCase.execute(dto);

    expect(userService.findOneByEmail).toHaveBeenCalledWith('ana@empresa.com');
    expect(emailVerificationCodeService.issue).toHaveBeenCalledWith('user-1');
    expect(emailService.sendRegistrationOtpNotification).toHaveBeenCalledWith(
      'ana@empresa.com',
      '123456',
    );
    expect(result.data).toEqual({
      email: 'ana@empresa.com',
      maskedEmail: 'a***a@empresa.com',
    });
  });

  it('lanza NotFoundException si no hay ningun pre-registro con ese correo', async () => {
    userService.findOneByEmail.mockResolvedValue(null);

    await expect(useCase.execute(dto)).rejects.toThrow(NotFoundException);
  });

  it('lanza ConflictException si el correo ya estaba verificado', async () => {
    userService.findOneByEmail.mockResolvedValue({
      ...user,
      isEmailVerified: true,
    });

    await expect(useCase.execute(dto)).rejects.toThrow(ConflictException);
    expect(emailVerificationCodeService.issue).not.toHaveBeenCalled();
  });

  it('bug corregido: si SendGrid falla al reenviar, no propaga un 500 porque el codigo ya quedo persistido (best-effort)', async () => {
    emailService.sendRegistrationOtpNotification.mockRejectedValue(
      new Error('Failed to send email'),
    );

    const result = await useCase.execute(dto);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      email: 'ana@empresa.com',
      maskedEmail: 'a***a@empresa.com',
    });
  });
});
