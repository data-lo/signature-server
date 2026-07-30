import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { AccountService } from '../account/account.service';
import { OrganizationInvitationService } from '../account/organization-invitation.service';
import { PasswordResetCodeService } from './password-reset-code.service';
import { EmailService } from '../shared/email/email.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';

describe('AuthService', () => {
  let service: AuthService;
  let userService: {
    createFromSignup: jest.Mock;
    findOne: jest.Mock;
    findOneByEmail: jest.Mock;
    updatePassword: jest.Mock;
    sanitize: jest.Mock;
  };
  let accountService: {
    findActiveAccountByEmail: jest.Mock;
    updatePasswordForUser: jest.Mock;
  };
  let organizationInvitationService: { acceptForUser: jest.Mock };
  let passwordResetCodeService: {
    issue: jest.Mock;
    verifyAndConsume: jest.Mock;
  };
  let emailService: { sendPasswordResetOtpNotification: jest.Mock };
  let passwordService: { hash: jest.Mock; compare: jest.Mock };
  let jwtService: { sign: jest.Mock; verifyAsync: jest.Mock };
  let redisService: { set: jest.Mock; get: jest.Mock };

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
      findOneByEmail: jest.fn().mockResolvedValue(user),
      updatePassword: jest.fn().mockResolvedValue(undefined),
      sanitize: jest.fn((u) => u),
    };
    accountService = {
      findActiveAccountByEmail: jest.fn().mockResolvedValue(account),
      updatePasswordForUser: jest.fn().mockResolvedValue(undefined),
    };
    organizationInvitationService = {
      acceptForUser: jest.fn().mockResolvedValue(undefined),
    };
    passwordResetCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    emailService = {
      sendPasswordResetOtpNotification: jest.fn().mockResolvedValue(undefined),
    };
    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-pw'),
      compare: jest.fn().mockResolvedValue(true),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-jwt'),
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        purpose: 'password_reset',
        iat: 1000,
      }),
    };
    redisService = { set: jest.fn(), get: jest.fn().mockResolvedValue(null) };

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
          provide: PasswordResetCodeService,
          useValue: passwordResetCodeService,
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

    it('hashea el password y delega en userService.createFromSignup', async () => {
      userService.createFromSignup.mockResolvedValue({
        success: true,
        data: { id: 'user-1' },
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

    it('si el dto trae invitationToken, une al usuario recién creado a esa organización', async () => {
      userService.createFromSignup.mockResolvedValue({
        success: true,
        data: { id: 'user-1' },
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
        data: { id: 'user-1' },
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

  describe('forgotPassword', () => {
    const dto = { email: 'ANA@empresa.com' };

    it('con correo existente y activo, emite y envía el OTP', async () => {
      const result = await service.forgotPassword(dto);

      expect(userService.findOneByEmail).toHaveBeenCalledWith(
        'ana@empresa.com',
      );
      expect(passwordResetCodeService.issue).toHaveBeenCalledWith('user-1');
      expect(
        emailService.sendPasswordResetOtpNotification,
      ).toHaveBeenCalledWith('ana@empresa.com', '123456');
      expect(result).toEqual({
        success: true,
        message:
          'Si el correo está registrado, recibirás un código de verificación',
        data: null,
      });
    });

    it('anti-enumeración: con correo inexistente, regresa el mismo mensaje genérico sin emitir OTP', async () => {
      userService.findOneByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword(dto);

      expect(passwordResetCodeService.issue).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message:
          'Si el correo está registrado, recibirás un código de verificación',
        data: null,
      });
    });

    it('anti-enumeración: con correo de una cuenta desactivada, mismo mensaje genérico sin emitir OTP', async () => {
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isActive: false,
      });

      const result = await service.forgotPassword(dto);

      expect(passwordResetCodeService.issue).not.toHaveBeenCalled();
      expect(result.message).toBe(
        'Si el correo está registrado, recibirás un código de verificación',
      );
    });

    it('bug corregido: si SendGrid falla, no propaga el error — el mensaje sigue siendo el genérico (best-effort)', async () => {
      emailService.sendPasswordResetOtpNotification.mockRejectedValue(
        new Error('Failed to send email'),
      );

      const result = await service.forgotPassword(dto);

      expect(result.success).toBe(true);
    });
  });

  describe('verifyResetCode', () => {
    const dto = { email: 'ANA@empresa.com', code: '123456' };

    it('consume el OTP y regresa un resetToken', async () => {
      const result = await service.verifyResetCode(dto);

      expect(passwordResetCodeService.verifyAndConsume).toHaveBeenCalledWith(
        'user-1',
        '123456',
      );
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-1', purpose: 'password_reset' },
        { expiresIn: '10m' },
      );
      expect(result.data.resetToken).toBe('signed-jwt');
    });

    it('rechaza con BadRequestException si no existe ningún usuario con ese correo', async () => {
      userService.findOneByEmail.mockResolvedValue(null);

      await expect(service.verifyResetCode(dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(passwordResetCodeService.verifyAndConsume).not.toHaveBeenCalled();
    });

    it('propaga el error si el código es inválido/expirado', async () => {
      passwordResetCodeService.verifyAndConsume.mockRejectedValue(
        new BadRequestException('El código de verificación expiró'),
      );

      await expect(service.verifyResetCode(dto)).rejects.toThrow(
        'El código de verificación expiró',
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const dto = {
      resetToken: 'reset-jwt',
      newPassword: 'NuevaPassword123!',
      confirmPassword: 'NuevaPassword123!',
    };

    it('actualiza la contraseña en User y Account, y fija token_valid_after', async () => {
      const result = await service.resetPassword(dto);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('reset-jwt');
      expect(passwordService.hash).toHaveBeenCalledWith('NuevaPassword123!');
      expect(userService.updatePassword).toHaveBeenCalledWith(
        'user-1',
        'hashed-pw',
      );
      expect(accountService.updatePasswordForUser).toHaveBeenCalledWith(
        'user-1',
        'hashed-pw',
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'token_valid_after:user-1',
        expect.any(String),
        expect.any(Number),
      );
      expect(result.success).toBe(true);
    });

    it('rechaza con UnauthorizedException si el token es inválido o expiró', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(service.resetPassword(dto)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });

    it('rechaza con UnauthorizedException si el token no tiene purpose:password_reset', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        purpose: 'other',
        iat: 1000,
      });

      await expect(service.resetPassword(dto)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });

    it('bug corregido: rechaza el reuso del mismo resetToken tras un reset previo (replay)', async () => {
      redisService.get.mockResolvedValue('2000');
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        purpose: 'password_reset',
        iat: 1000,
      });

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Este enlace ya fue utilizado',
      );
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });
  });
});
