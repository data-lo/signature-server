import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountService } from 'src/account/account.service';
import { PasswordService } from 'src/shared/password/password.service';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { ResetPasswordUseCase } from './reset-password.use-case';

describe('ResetPasswordUseCase', () => {
  let useCase: ResetPasswordUseCase;
  let userService: { updatePassword: jest.Mock };
  let accountService: { updatePasswordForUser: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let authService: {
    verifyPasswordResetToken: jest.Mock;
    getSessionsValidAfter: jest.Mock;
    invalidateSessionsFor: jest.Mock;
  };

  const dto = {
    resetToken: 'reset-jwt',
    newPassword: 'NuevaPassword123!',
    confirmPassword: 'NuevaPassword123!',
  };

  beforeEach(async () => {
    userService = { updatePassword: jest.fn().mockResolvedValue(undefined) };
    accountService = {
      updatePasswordForUser: jest.fn().mockResolvedValue(undefined),
    };
    passwordService = { hash: jest.fn().mockResolvedValue('hashed-pw') };
    authService = {
      verifyPasswordResetToken: jest.fn().mockResolvedValue({
        sub: 'user-1',
        purpose: 'password_reset',
        iat: 1000,
      }),
      getSessionsValidAfter: jest.fn().mockResolvedValue(null),
      invalidateSessionsFor: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResetPasswordUseCase,
        { provide: UserService, useValue: userService },
        { provide: AccountService, useValue: accountService },
        { provide: PasswordService, useValue: passwordService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    useCase = module.get(ResetPasswordUseCase);
  });

  it('actualiza la contrasena en User y Account, e invalida las sesiones previas', async () => {
    const result = await useCase.execute(dto);

    expect(authService.verifyPasswordResetToken).toHaveBeenCalledWith(
      'reset-jwt',
    );
    expect(passwordService.hash).toHaveBeenCalledWith('NuevaPassword123!');
    expect(userService.updatePassword).toHaveBeenCalledWith(
      'user-1',
      'hashed-pw',
    );
    expect(accountService.updatePasswordForUser).toHaveBeenCalledWith(
      'user-1',
      'hashed-pw',
    );
    expect(authService.invalidateSessionsFor).toHaveBeenCalledWith('user-1');
    expect(result.success).toBe(true);
  });

  it('rechaza con UnauthorizedException si el token es invalido, expiro o no es de reset', async () => {
    authService.verifyPasswordResetToken.mockRejectedValue(
      new UnauthorizedException('Token inválido o expirado'),
    );

    await expect(useCase.execute(dto)).rejects.toThrow(UnauthorizedException);
    expect(userService.updatePassword).not.toHaveBeenCalled();
  });

  it('bug corregido: rechaza el reuso del mismo resetToken tras un reset previo (replay)', async () => {
    authService.getSessionsValidAfter.mockResolvedValue(2000);

    await expect(useCase.execute(dto)).rejects.toThrow(
      'Este enlace ya fue utilizado',
    );
    expect(userService.updatePassword).not.toHaveBeenCalled();
  });

  /** Un token emitido después de la última invalidación sigue sirviendo: no es un replay. */
  it('acepta un resetToken emitido despues de la ultima invalidacion', async () => {
    authService.getSessionsValidAfter.mockResolvedValue(500);

    await expect(useCase.execute(dto)).resolves.toMatchObject({
      success: true,
    });
  });
});
