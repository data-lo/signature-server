import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { AccountService } from '../account/account.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';

describe('AuthService', () => {
  let service: AuthService;
  let userService: {
    createFromSignup: jest.Mock;
    findOne: jest.Mock;
    sanitize: jest.Mock;
  };
  let accountService: { findActiveAccountByEmail: jest.Mock };
  let passwordService: { hash: jest.Mock; compare: jest.Mock };
  let jwtService: { sign: jest.Mock };
  let redisService: { set: jest.Mock };

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
    roles: ['signer'],
    nationalId: 'GOMA900101MDFRNN01',
    isActive: true,
  };

  beforeEach(async () => {
    userService = {
      createFromSignup: jest.fn(),
      findOne: jest.fn().mockResolvedValue(user),
      sanitize: jest.fn((u) => u),
    };
    accountService = {
      findActiveAccountByEmail: jest.fn().mockResolvedValue(account),
    };
    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-pw'),
      compare: jest.fn().mockResolvedValue(true),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed-jwt') };
    redisService = { set: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: AccountService, useValue: accountService },
        { provide: JwtService, useValue: jwtService },
        { provide: PasswordService, useValue: passwordService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('login', () => {
    const dto = { email: 'ANA@empresa.com', password: 'Password123!' };

    it('resuelve la credencial contra Account.email/.password y arma el JWT desde UserEntity', async () => {
      const result = await service.login(dto);

      expect(accountService.findActiveAccountByEmail).toHaveBeenCalledWith(
        'ana@empresa.com',
      );
      expect(passwordService.compare).toHaveBeenCalledWith(
        'Password123!',
        'hashed-pw',
      );
      expect(userService.findOne).toHaveBeenCalledWith('user-1');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: 'ana@empresa.com',
          nationalId: 'GOMA900101MDFRNN01',
        }),
      );
      expect(result.data.token).toBe('signed-jwt');
    });

    it('rechaza con UnauthorizedException si no existe ninguna cuenta activa con ese email', async () => {
      accountService.findActiveAccountByEmail.mockResolvedValue(null);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(passwordService.compare).not.toHaveBeenCalled();
    });

    it('rechaza con UnauthorizedException si el password no coincide', async () => {
      passwordService.compare.mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(userService.findOne).not.toHaveBeenCalled();
    });

    it('rechaza con UnauthorizedException si el usuario resuelto ya no está activo', async () => {
      userService.findOne.mockResolvedValue({ ...user, isActive: false });

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza con UnauthorizedException si el usuario resuelto ya no existe', async () => {
      userService.findOne.mockRejectedValue(new Error('Usuario no encontrado'));

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('register', () => {
    it('hashea el password y delega en userService.createFromSignup', async () => {
      userService.createFromSignup.mockResolvedValue({ success: true });
      const dto = {
        firstName: 'Ana',
        lastName: 'Gómez',
        email: 'ana@empresa.com',
        position: 'Analista',
        nationalId: 'GOMA900101MDFRNN01',
        rfc: 'GOMA900101XYZ',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      };

      await service.register(dto as any);

      expect(passwordService.hash).toHaveBeenCalledWith('Password123!');
      expect(userService.createFromSignup).toHaveBeenCalledWith(
        dto,
        'hashed-pw',
      );
    });
  });
});
