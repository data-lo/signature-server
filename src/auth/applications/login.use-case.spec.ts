import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountService } from 'src/account/account.service';
import { PasswordService } from 'src/shared/password/password.service';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { LoginUseCase } from './login.use-case';

describe('LoginUseCase', () => {
  let useCase: LoginUseCase;
  let accountService: { findActiveAccountByEmail: jest.Mock };
  let userService: { findOne: jest.Mock; sanitize: jest.Mock };
  let passwordService: { compare: jest.Mock };
  let authService: { signJwtForUser: jest.Mock };

  const dto = { email: 'ANA@empresa.com', password: 'Password123!' };
  const account = {
    id: 'account-1',
    userId: 'user-1',
    email: 'ana@empresa.com',
    password: 'hashed-pw',
    isActive: true,
  };
  const user = {
    id: 'user-1',
    email: 'ana@empresa.com',
    password: 'hashed-pw',
    roles: ['signer'],
    nationalId: 'GOMA900101MDFRNN01',
    isActive: true,
    isEmailVerified: true,
  };

  beforeEach(async () => {
    accountService = {
      findActiveAccountByEmail: jest.fn().mockResolvedValue(account),
    };
    userService = {
      findOne: jest.fn().mockResolvedValue(user),
      sanitize: jest.fn((u) => u),
    };
    passwordService = { compare: jest.fn().mockResolvedValue(true) };
    authService = { signJwtForUser: jest.fn().mockReturnValue('signed-jwt') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoginUseCase,
        { provide: AccountService, useValue: accountService },
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    useCase = module.get(LoginUseCase);
  });

  it('resuelve la credencial contra Account.email/.password y arma el JWT desde UserEntity', async () => {
    const result = await useCase.execute(dto);

    expect(accountService.findActiveAccountByEmail).toHaveBeenCalledWith(
      'ana@empresa.com',
    );
    expect(passwordService.compare).toHaveBeenCalledWith(
      'Password123!',
      'hashed-pw',
    );
    expect(userService.findOne).toHaveBeenCalledWith('user-1');
    expect(authService.signJwtForUser).toHaveBeenCalledWith(user);
    expect(result.data.token).toBe('signed-jwt');
  });

  it('sanea el usuario antes de devolverlo', async () => {
    const sanitized = { ...user, password: undefined };
    userService.sanitize.mockReturnValue(sanitized);

    const result = await useCase.execute(dto);

    expect(userService.sanitize).toHaveBeenCalledWith(user);
    expect(result.data.user).toBe(sanitized);
  });

  it('rechaza con UnauthorizedException si no existe ninguna cuenta activa con ese email', async () => {
    accountService.findActiveAccountByEmail.mockResolvedValue(null);

    await expect(useCase.execute(dto)).rejects.toThrow(UnauthorizedException);
    expect(passwordService.compare).not.toHaveBeenCalled();
  });

  it('rechaza con UnauthorizedException si el password no coincide', async () => {
    passwordService.compare.mockResolvedValue(false);

    await expect(useCase.execute(dto)).rejects.toThrow(UnauthorizedException);
    expect(userService.findOne).not.toHaveBeenCalled();
  });

  it('rechaza con UnauthorizedException si el usuario resuelto ya no esta activo', async () => {
    userService.findOne.mockResolvedValue({ ...user, isActive: false });

    await expect(useCase.execute(dto)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza con UnauthorizedException si el usuario resuelto ya no existe', async () => {
    userService.findOne.mockRejectedValue(new Error('Usuario no encontrado'));

    await expect(useCase.execute(dto)).rejects.toThrow(UnauthorizedException);
  });

  it('bug corregido: rechaza con ForbiddenException si la cuenta todavia no verifica su correo (pre-registro)', async () => {
    userService.findOne.mockResolvedValue({ ...user, isEmailVerified: false });

    await expect(useCase.execute(dto)).rejects.toThrow(ForbiddenException);
    expect(authService.signJwtForUser).not.toHaveBeenCalled();
  });
});
