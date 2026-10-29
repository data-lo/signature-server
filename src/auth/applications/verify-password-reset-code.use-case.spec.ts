import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { PasswordResetCodeService } from '../password-reset-code.service';
import { VerifyPasswordResetCodeUseCase } from './verify-password-reset-code.use-case';

describe('VerifyPasswordResetCodeUseCase', () => {
  let useCase: VerifyPasswordResetCodeUseCase;
  let userService: { findOneByEmail: jest.Mock };
  let passwordResetCodeService: { verifyAndConsume: jest.Mock };
  let authService: { signPasswordResetToken: jest.Mock };

  const dto = { email: 'ANA@empresa.com', code: '123456' };
  const user = { id: 'user-1', email: 'ana@empresa.com' };

  beforeEach(async () => {
    userService = { findOneByEmail: jest.fn().mockResolvedValue(user) };
    passwordResetCodeService = {
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    authService = {
      signPasswordResetToken: jest.fn().mockReturnValue('signed-jwt'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerifyPasswordResetCodeUseCase,
        { provide: UserService, useValue: userService },
        {
          provide: PasswordResetCodeService,
          useValue: passwordResetCodeService,
        },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    useCase = module.get(VerifyPasswordResetCodeUseCase);
  });

  it('consume el OTP y regresa un resetToken', async () => {
    const result = await useCase.execute(dto);

    expect(userService.findOneByEmail).toHaveBeenCalledWith('ana@empresa.com');
    expect(passwordResetCodeService.verifyAndConsume).toHaveBeenCalledWith(
      'user-1',
      '123456',
    );
    expect(authService.signPasswordResetToken).toHaveBeenCalledWith('user-1');
    expect(result.data.resetToken).toBe('signed-jwt');
  });

  it('rechaza con BadRequestException si no existe ningun usuario con ese correo', async () => {
    userService.findOneByEmail.mockResolvedValue(null);

    await expect(useCase.execute(dto)).rejects.toThrow(BadRequestException);
    expect(passwordResetCodeService.verifyAndConsume).not.toHaveBeenCalled();
  });

  it('propaga el error si el codigo es invalido o expirado', async () => {
    passwordResetCodeService.verifyAndConsume.mockRejectedValue(
      new BadRequestException('El código de verificación expiró'),
    );

    await expect(useCase.execute(dto)).rejects.toThrow(
      'El código de verificación expiró',
    );
    expect(authService.signPasswordResetToken).not.toHaveBeenCalled();
  });
});
