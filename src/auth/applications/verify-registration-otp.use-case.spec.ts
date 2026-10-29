import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { EmailVerificationCodeService } from 'src/user/email-verification-code.service';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { VerifyRegistrationOtpUseCase } from './verify-registration-otp.use-case';

describe('VerifyRegistrationOtpUseCase', () => {
  let useCase: VerifyRegistrationOtpUseCase;
  let userService: {
    findOneByEmail: jest.Mock;
    markEmailVerified: jest.Mock;
    sanitize: jest.Mock;
  };
  let emailVerificationCodeService: { verifyAndConsume: jest.Mock };
  let authService: { signJwtForUser: jest.Mock };

  const dto = { email: 'ANA@empresa.com', code: '123456' };
  const user = {
    id: 'user-1',
    email: 'ana@empresa.com',
    isEmailVerified: false,
  };

  beforeEach(async () => {
    userService = {
      findOneByEmail: jest.fn().mockResolvedValue(user),
      markEmailVerified: jest
        .fn()
        .mockResolvedValue({ ...user, isEmailVerified: true }),
      sanitize: jest.fn((u) => u),
    };
    emailVerificationCodeService = {
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    authService = { signJwtForUser: jest.fn().mockReturnValue('signed-jwt') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerifyRegistrationOtpUseCase,
        { provide: UserService, useValue: userService },
        {
          provide: EmailVerificationCodeService,
          useValue: emailVerificationCodeService,
        },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    useCase = module.get(VerifyRegistrationOtpUseCase);
  });

  it('valida el OTP, marca isEmailVerified=true y autentica al usuario (auto-login)', async () => {
    const result = await useCase.execute(dto);

    expect(userService.findOneByEmail).toHaveBeenCalledWith('ana@empresa.com');
    expect(emailVerificationCodeService.verifyAndConsume).toHaveBeenCalledWith(
      'user-1',
      '123456',
    );
    expect(userService.markEmailVerified).toHaveBeenCalledWith('user-1');
    expect(result.data.token).toBe('signed-jwt');
  });

  /** El JWT se firma con el usuario ya verificado, no con la foto previa al canje del OTP. */
  it('firma el token con el usuario ya marcado como verificado', async () => {
    const verified = { ...user, isEmailVerified: true };
    userService.markEmailVerified.mockResolvedValue(verified);

    await useCase.execute(dto);

    expect(authService.signJwtForUser).toHaveBeenCalledWith(verified);
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
    expect(
      emailVerificationCodeService.verifyAndConsume,
    ).not.toHaveBeenCalled();
  });

  it('propaga el error del OTP invalido/expirado sin marcar la cuenta como verificada', async () => {
    emailVerificationCodeService.verifyAndConsume.mockRejectedValue(
      new Error('Código de verificación inválido'),
    );

    await expect(useCase.execute(dto)).rejects.toThrow(
      'Código de verificación inválido',
    );
    expect(userService.markEmailVerified).not.toHaveBeenCalled();
  });
});
