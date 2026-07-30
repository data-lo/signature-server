import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { AccountService } from '../account/account.service';
import { OrganizationInvitationService } from '../account/organization-invitation.service';
import { EmailVerificationCodeService } from '../user/email-verification-code.service';
import { EmailService } from '../shared/email/email.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';

describe('AuthService', () => {
  let service: AuthService;
  let userService: {
    createFromSignup: jest.Mock;
    findOne: jest.Mock;
    findOneByEmail: jest.Mock;
    markEmailVerified: jest.Mock;
    sanitize: jest.Mock;
  };
  let accountService: { findActiveAccountByEmail: jest.Mock };
  let organizationInvitationService: { acceptForUser: jest.Mock };
  let emailVerificationCodeService: {
    issue: jest.Mock;
    verifyAndConsume: jest.Mock;
  };
  let emailService: { sendRegistrationOtpNotification: jest.Mock };
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
    isEmailVerified: true,
  };

  beforeEach(async () => {
    userService = {
      createFromSignup: jest.fn(),
      findOne: jest.fn().mockResolvedValue(user),
      findOneByEmail: jest.fn().mockResolvedValue(user),
      markEmailVerified: jest
        .fn()
        .mockResolvedValue({ ...user, isEmailVerified: true }),
      sanitize: jest.fn((u) => u),
    };
    accountService = {
      findActiveAccountByEmail: jest.fn().mockResolvedValue(account),
    };
    organizationInvitationService = {
      acceptForUser: jest.fn().mockResolvedValue(undefined),
    };
    emailVerificationCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    emailService = {
      sendRegistrationOtpNotification: jest.fn().mockResolvedValue(undefined),
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
        {
          provide: OrganizationInvitationService,
          useValue: organizationInvitationService,
        },
        {
          provide: EmailVerificationCodeService,
          useValue: emailVerificationCodeService,
        },
        { provide: EmailService, useValue: emailService },
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

    it('bug corregido: rechaza con ForbiddenException si la cuenta todavía no verifica su correo (pre-registro)', async () => {
      userService.findOne.mockResolvedValue({
        ...user,
        isEmailVerified: false,
      });

      await expect(service.login(dto)).rejects.toThrow(ForbiddenException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe('register', () => {
    const dto = {
      firstName: 'Ana',
      lastName: 'Gómez',
      email: 'ana@empresa.com',
      nationalId: 'GOMA900101MDFRNN01',
      rfc: 'GOMA900101XYZ',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    };
    const pendingVerificationData = {
      userId: 'user-1',
      email: 'ana@empresa.com',
      maskedEmail: 'a***a@empresa.com',
      isNewPreRegistration: true,
    };

    it('hashea el password y delega en userService.createFromSignup', async () => {
      userService.createFromSignup.mockResolvedValue({
        success: true,
        data: pendingVerificationData,
      });

      await service.register(dto as any);

      expect(passwordService.hash).toHaveBeenCalledWith('Password123!');
      expect(userService.createFromSignup).toHaveBeenCalledWith(
        dto,
        'hashed-pw',
      );
      expect(
        organizationInvitationService.acceptForUser,
      ).not.toHaveBeenCalled();
    });

    it('si el dto trae invitationToken, une al usuario recién creado (o al pre-registro existente) a esa organización', async () => {
      userService.createFromSignup.mockResolvedValue({
        success: true,
        data: pendingVerificationData,
      });

      await service.register({
        ...dto,
        invitationToken: 'invite-token-1',
      } as any);

      expect(organizationInvitationService.acceptForUser).toHaveBeenCalledWith(
        'invite-token-1',
        'user-1',
      );
    });

    it('no falla el registro si acceptForUser rechaza (best-effort)', async () => {
      userService.createFromSignup.mockResolvedValue({
        success: true,
        data: pendingVerificationData,
      });
      organizationInvitationService.acceptForUser.mockRejectedValue(
        new Error('Invitación no encontrada'),
      );

      const result = await service.register({
        ...dto,
        invitationToken: 'bad-token',
      } as any);

      expect(result.success).toBe(true);
    });
  });

  describe('verifyOtp', () => {
    const dto = { email: 'ANA@empresa.com', code: '123456' };

    beforeEach(() => {
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isEmailVerified: false,
      });
    });

    it('valida el OTP, marca isEmailVerified=true y autentica al usuario (auto-login)', async () => {
      const result = await service.verifyOtp(dto);

      expect(userService.findOneByEmail).toHaveBeenCalledWith(
        'ana@empresa.com',
      );
      expect(emailVerificationCodeService.verifyAndConsume).toHaveBeenCalledWith(
        'user-1',
        '123456',
      );
      expect(userService.markEmailVerified).toHaveBeenCalledWith('user-1');
      expect(jwtService.sign).toHaveBeenCalled();
      expect(result.data.token).toBe('signed-jwt');
    });

    it('lanza NotFoundException si no hay ningún pre-registro con ese correo', async () => {
      userService.findOneByEmail.mockResolvedValue(null);

      await expect(service.verifyOtp(dto)).rejects.toThrow(NotFoundException);
    });

    it('lanza ConflictException si el correo ya estaba verificado', async () => {
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isEmailVerified: true,
      });

      await expect(service.verifyOtp(dto)).rejects.toThrow(ConflictException);
      expect(emailVerificationCodeService.verifyAndConsume).not.toHaveBeenCalled();
    });

    it('propaga el error del OTP inválido/expirado sin marcar la cuenta como verificada', async () => {
      emailVerificationCodeService.verifyAndConsume.mockRejectedValue(
        new Error('Código de verificación inválido'),
      );

      await expect(service.verifyOtp(dto)).rejects.toThrow(
        'Código de verificación inválido',
      );
      expect(userService.markEmailVerified).not.toHaveBeenCalled();
    });
  });

  describe('resendOtp', () => {
    const dto = { email: 'ANA@empresa.com' };

    beforeEach(() => {
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isEmailVerified: false,
      });
    });

    it('emite un nuevo OTP y lo envía al correo del pre-registro', async () => {
      const result = await service.resendOtp(dto);

      expect(userService.findOneByEmail).toHaveBeenCalledWith(
        'ana@empresa.com',
      );
      expect(emailVerificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
      );
      expect(
        emailService.sendRegistrationOtpNotification,
      ).toHaveBeenCalledWith('ana@empresa.com', '123456');
      expect(result.data).toEqual({
        email: 'ana@empresa.com',
        maskedEmail: 'a***a@empresa.com',
      });
    });

    it('lanza NotFoundException si no hay ningún pre-registro con ese correo', async () => {
      userService.findOneByEmail.mockResolvedValue(null);

      await expect(service.resendOtp(dto)).rejects.toThrow(NotFoundException);
    });

    it('lanza ConflictException si el correo ya estaba verificado', async () => {
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isEmailVerified: true,
      });

      await expect(service.resendOtp(dto)).rejects.toThrow(ConflictException);
      expect(emailVerificationCodeService.issue).not.toHaveBeenCalled();
    });

    it('bug corregido: si SendGrid falla al reenviar, no propaga un 500 — el código ya quedó persistido (best-effort)', async () => {
      emailService.sendRegistrationOtpNotification.mockRejectedValue(
        new Error('Failed to send email'),
      );

      const result = await service.resendOtp(dto);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        email: 'ana@empresa.com',
        maskedEmail: 'a***a@empresa.com',
      });
    });
  });
});
