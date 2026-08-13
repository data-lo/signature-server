import {
  BadRequestException,
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
import { PasswordResetCodeService } from './password-reset-code.service';
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
    updatePassword: jest.Mock;
    markEmailVerified: jest.Mock;
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
  let emailVerificationCodeService: {
    issue: jest.Mock;
    verifyAndConsume: jest.Mock;
  };
  let emailService: {
    sendPasswordResetOtpNotification: jest.Mock;
    sendRegistrationOtpNotification: jest.Mock;
  };
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
    isEmailVerified: true,
  };

  beforeEach(async () => {
    userService = {
      createFromSignup: jest.fn(),
      findOne: jest.fn().mockResolvedValue(user),
      findOneByEmail: jest.fn().mockResolvedValue(user),
      updatePassword: jest.fn().mockResolvedValue(undefined),
      markEmailVerified: jest
        .fn()
        .mockResolvedValue({ ...user, isEmailVerified: true }),
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
    emailVerificationCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    emailService = {
      sendPasswordResetOtpNotification: jest.fn().mockResolvedValue(undefined),
      sendRegistrationOtpNotification: jest.fn().mockResolvedValue(undefined),
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
      expect(
        emailVerificationCodeService.verifyAndConsume,
      ).toHaveBeenCalledWith('user-1', '123456');
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
      expect(
        emailVerificationCodeService.verifyAndConsume,
      ).not.toHaveBeenCalled();
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

    /**
     * Este flujo estuvo caído en producción sin que nadie lo notara: todos los motivos por los
     * que no se manda el correo devuelven el mismo mensaje genérico (correcto, anti-enumeración)
     * y además NO dejaban rastro en el servidor. Cada motivo debe quedar registrado por
     * separado, sin cambiar jamás la respuesta al cliente.
     */
    describe('diagnóstico en el servidor (sin romper la anti-enumeración)', () => {
      const GENERIC =
        'Si el correo está registrado, recibirás un código de verificación';

      it('si falla la EMISIÓN del código (base de datos), lo registra como tal y no lo atribuye al correo', async () => {
        const warn = jest
          .spyOn(service['logger'], 'error')
          .mockImplementation(() => undefined);
        passwordResetCodeService.issue.mockRejectedValue(
          new Error('relation "password_reset_codes" does not exist'),
        );

        const result = await service.forgotPassword(dto);

        expect(
          emailService.sendPasswordResetOtpNotification,
        ).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/no se pudo EMITIR el código/i),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/password_reset_codes/),
        );
        // La respuesta al cliente no cambia.
        expect(result).toEqual({ success: true, message: GENERIC, data: null });
      });

      it('deja rastro cuando el correo no corresponde a ningún usuario', async () => {
        const warn = jest
          .spyOn(service['logger'], 'warn')
          .mockImplementation(() => undefined);
        userService.findOneByEmail.mockResolvedValue(null);

        const result = await service.forgotPassword(dto);

        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/sin usuario registrado/i),
        );
        expect(result.message).toBe(GENERIC);
      });

      it('deja rastro cuando el usuario está inactivo', async () => {
        const warn = jest
          .spyOn(service['logger'], 'warn')
          .mockImplementation(() => undefined);
        userService.findOneByEmail.mockResolvedValue({
          ...user,
          isActive: false,
        });

        const result = await service.forgotPassword(dto);

        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/usuario inactivo/i),
        );
        expect(result.message).toBe(GENERIC);
      });

      it('la respuesta es byte a byte idéntica en los cuatro escenarios', async () => {
        jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
        jest
          .spyOn(service['logger'], 'error')
          .mockImplementation(() => undefined);

        const ok = await service.forgotPassword(dto);

        userService.findOneByEmail.mockResolvedValue(null);
        const inexistente = await service.forgotPassword(dto);

        userService.findOneByEmail.mockResolvedValue({
          ...user,
          isActive: false,
        });
        const inactivo = await service.forgotPassword(dto);

        userService.findOneByEmail.mockResolvedValue(user);
        passwordResetCodeService.issue.mockRejectedValue(new Error('db caida'));
        const fallo = await service.forgotPassword(dto);

        expect(inexistente).toEqual(ok);
        expect(inactivo).toEqual(ok);
        expect(fallo).toEqual(ok);
      });
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
