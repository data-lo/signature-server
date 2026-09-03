import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountService } from 'src/account/account.service';
import { PasswordService } from 'src/shared/password/password.service';

import { ChangeMyPasswordUseCase } from './change-my-password.use-case';
import { UserService } from '../user.service';

describe('ChangeMyPasswordUseCase', () => {
  let useCase: ChangeMyPasswordUseCase;
  let userService: { findOne: jest.Mock; updatePassword: jest.Mock };
  let accountService: { updatePasswordForUser: jest.Mock };
  let passwordService: { compare: jest.Mock; hash: jest.Mock };

  const dto = {
    currentPassword: 'contrasenaActual',
    newPassword: 'contrasenaNueva',
    confirmPassword: 'contrasenaNueva',
  };

  beforeEach(async () => {
    userService = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', password: 'hash-actual' }),
      updatePassword: jest.fn().mockResolvedValue(undefined),
    };
    accountService = {
      updatePasswordForUser: jest.fn().mockResolvedValue(undefined),
    };
    passwordService = {
      compare: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue('hash-nuevo'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChangeMyPasswordUseCase,
        { provide: UserService, useValue: userService },
        { provide: AccountService, useValue: accountService },
        { provide: PasswordService, useValue: passwordService },
      ],
    }).compile();

    useCase = module.get(ChangeMyPasswordUseCase);
  });

  it('verifica la contraseña actual contra el hash guardado del usuario', async () => {
    await useCase.execute('user-1', dto);

    expect(passwordService.compare).toHaveBeenCalledWith(
      'contrasenaActual',
      'hash-actual',
    );
  });

  /**
   * Las dos escrituras hacen falta: `login()` resuelve contra `Account.password` (copia
   * sincronizada de la credencial del usuario, decisión D6), así que guardar solo una dejaría al
   * usuario sin poder entrar con ninguna de las dos contraseñas.
   */
  it('guarda el hash nuevo en el usuario y en sus cuentas', async () => {
    const result = await useCase.execute('user-1', dto);

    expect(passwordService.hash).toHaveBeenCalledWith('contrasenaNueva');
    expect(userService.updatePassword).toHaveBeenCalledWith(
      'user-1',
      'hash-nuevo',
    );
    expect(accountService.updatePasswordForUser).toHaveBeenCalledWith(
      'user-1',
      'hash-nuevo',
    );
    expect(result).toEqual({
      success: true,
      message: 'Contraseña actualizada correctamente',
      data: null,
    });
  });

  it('rechaza con 401 si la contraseña actual no coincide, sin escribir nada', async () => {
    passwordService.compare.mockResolvedValue(false);

    await expect(useCase.execute('user-1', dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(userService.updatePassword).not.toHaveBeenCalled();
    expect(accountService.updatePasswordForUser).not.toHaveBeenCalled();
  });

  /** El JWT puede seguir siendo válido para un usuario que ya no existe o fue desactivado. */
  it('rechaza con 401 si el usuario del token ya no puede operar', async () => {
    userService.findOne.mockRejectedValue(new Error('Usuario no activo'));

    await expect(useCase.execute('user-1', dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(userService.updatePassword).not.toHaveBeenCalled();
  });
});
