import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountService } from 'src/account/account.service';
import { PasswordService } from 'src/common/password/password.service';
import {
  PasswordPolicyService,
  WEAK_PASSWORD_MESSAGE,
} from 'src/common/password/password-policy.service';
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
  /** La política real: es la misma que usan el registro y el cambio. */
  let passwordPolicy: PasswordPolicyService;

  const dto = {
    resetToken: 'reset-jwt',
    newPassword: 'el tren sale del andén siete',
    confirmPassword: 'el tren sale del andén siete',
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
        PasswordPolicyService,
      ],
    }).compile();

    useCase = module.get(ResetPasswordUseCase);
    passwordPolicy = module.get(PasswordPolicyService);
  });

  it('actualiza la contrasena en User y Account, e invalida las sesiones previas', async () => {
    const result = await useCase.execute(dto);

    expect(authService.verifyPasswordResetToken).toHaveBeenCalledWith(
      'reset-jwt',
    );
    expect(passwordService.hash).toHaveBeenCalledWith(
      'el tren sale del andén siete',
    );
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

  /**
   * Historia "Centralizar política de contraseñas en PasswordPolicyService": la política se aplica
   * a `newPassword`, después de validar el token y antes de escribir nada.
   */
  describe('política de contraseñas', () => {
    it('valida newPassword con la política antes de hashearla', async () => {
      const assertValid = jest.spyOn(passwordPolicy, 'assertValid');

      await useCase.execute(dto);

      expect(assertValid).toHaveBeenCalledWith('el tren sale del andén siete');
      expect(assertValid.mock.invocationCallOrder[0]).toBeLessThan(
        passwordService.hash.mock.invocationCallOrder[0],
      );
    });

    /**
     * El token no se invalida: el reset sólo invalida sesiones al final, así que el usuario puede
     * reintentar con otra contraseña usando el mismo enlace.
     */
    it.each(['Password123!', 'admin1234567', 'corta'])(
      'rechaza %p con 400 genérico, sin escribir ni invalidar sesiones',
      async (password) => {
        const error = await useCase
          .execute({ ...dto, newPassword: password, confirmPassword: password })
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toBe(
          WEAK_PASSWORD_MESSAGE,
        );
        expect(passwordService.hash).not.toHaveBeenCalled();
        expect(userService.updatePassword).not.toHaveBeenCalled();
        expect(accountService.updatePasswordForUser).not.toHaveBeenCalled();
        expect(authService.invalidateSessionsFor).not.toHaveBeenCalled();
      },
    );
  });
});
