import { Test, TestingModule } from '@nestjs/testing';

import { EmailService } from 'src/shared/email/email.service';
import { UserService } from 'src/user/user.service';

import { PasswordResetCodeService } from '../password-reset-code.service';
import { RequestPasswordResetUseCase } from './request-password-reset.use-case';

const GENERIC =
  'Si el correo está registrado, recibirás un código de verificación';

describe('RequestPasswordResetUseCase', () => {
  let useCase: RequestPasswordResetUseCase;
  let userService: { findOneByEmail: jest.Mock };
  let passwordResetCodeService: { issue: jest.Mock };
  let emailService: { sendPasswordResetOtpNotification: jest.Mock };

  const dto = { email: 'ANA@empresa.com' };
  const user = { id: 'user-1', email: 'ana@empresa.com', isActive: true };

  beforeEach(async () => {
    userService = { findOneByEmail: jest.fn().mockResolvedValue(user) };
    passwordResetCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
    };
    emailService = {
      sendPasswordResetOtpNotification: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestPasswordResetUseCase,
        { provide: UserService, useValue: userService },
        {
          provide: PasswordResetCodeService,
          useValue: passwordResetCodeService,
        },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    useCase = module.get(RequestPasswordResetUseCase);
  });

  it('con correo existente y activo, emite y envia el OTP', async () => {
    const result = await useCase.execute(dto);

    expect(userService.findOneByEmail).toHaveBeenCalledWith('ana@empresa.com');
    expect(passwordResetCodeService.issue).toHaveBeenCalledWith('user-1');
    expect(emailService.sendPasswordResetOtpNotification).toHaveBeenCalledWith(
      'ana@empresa.com',
      '123456',
    );
    expect(result).toEqual({ success: true, message: GENERIC, data: null });
  });

  it('anti-enumeracion: con correo inexistente, regresa el mismo mensaje generico sin emitir OTP', async () => {
    userService.findOneByEmail.mockResolvedValue(null);

    const result = await useCase.execute(dto);

    expect(passwordResetCodeService.issue).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: GENERIC, data: null });
  });

  it('anti-enumeracion: con correo de una cuenta desactivada, mismo mensaje generico sin emitir OTP', async () => {
    userService.findOneByEmail.mockResolvedValue({ ...user, isActive: false });

    const result = await useCase.execute(dto);

    expect(passwordResetCodeService.issue).not.toHaveBeenCalled();
    expect(result.message).toBe(GENERIC);
  });

  it('bug corregido: si SendGrid falla, no propaga el error y el mensaje sigue siendo el generico (best-effort)', async () => {
    emailService.sendPasswordResetOtpNotification.mockRejectedValue(
      new Error('Failed to send email'),
    );

    const result = await useCase.execute(dto);

    expect(result.success).toBe(true);
  });

  /**
   * Este flujo estuvo caído en producción sin que nadie lo notara: todos los motivos por los
   * que no se manda el correo devuelven el mismo mensaje genérico (correcto, anti-enumeración)
   * y además NO dejaban rastro en el servidor. Cada motivo debe quedar registrado por
   * separado, sin cambiar jamás la respuesta al cliente.
   */
  describe('diagnostico en el servidor (sin romper la anti-enumeracion)', () => {
    it('si falla la EMISION del codigo (base de datos), lo registra como tal y no lo atribuye al correo', async () => {
      const error = jest
        .spyOn(useCase['logger'], 'error')
        .mockImplementation(() => undefined);
      passwordResetCodeService.issue.mockRejectedValue(
        new Error('relation "password_reset_codes" does not exist'),
      );

      const result = await useCase.execute(dto);

      expect(
        emailService.sendPasswordResetOtpNotification,
      ).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/no se pudo EMITIR el código/i),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/password_reset_codes/),
      );
      // La respuesta al cliente no cambia.
      expect(result).toEqual({ success: true, message: GENERIC, data: null });
    });

    it('deja rastro cuando el correo no corresponde a ningun usuario', async () => {
      const warn = jest
        .spyOn(useCase['logger'], 'warn')
        .mockImplementation(() => undefined);
      userService.findOneByEmail.mockResolvedValue(null);

      const result = await useCase.execute(dto);

      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/sin usuario registrado/i),
      );
      expect(result.message).toBe(GENERIC);
    });

    it('deja rastro cuando el usuario esta inactivo', async () => {
      const warn = jest
        .spyOn(useCase['logger'], 'warn')
        .mockImplementation(() => undefined);
      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isActive: false,
      });

      const result = await useCase.execute(dto);

      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/usuario inactivo/i),
      );
      expect(result.message).toBe(GENERIC);
    });

    it('la respuesta es byte a byte identica en los cuatro escenarios', async () => {
      jest.spyOn(useCase['logger'], 'warn').mockImplementation(() => undefined);
      jest
        .spyOn(useCase['logger'], 'error')
        .mockImplementation(() => undefined);

      const ok = await useCase.execute(dto);

      userService.findOneByEmail.mockResolvedValue(null);
      const inexistente = await useCase.execute(dto);

      userService.findOneByEmail.mockResolvedValue({
        ...user,
        isActive: false,
      });
      const inactivo = await useCase.execute(dto);

      userService.findOneByEmail.mockResolvedValue(user);
      passwordResetCodeService.issue.mockRejectedValue(new Error('db caida'));
      const fallo = await useCase.execute(dto);

      expect(inexistente).toEqual(ok);
      expect(inactivo).toEqual(ok);
      expect(fallo).toEqual(ok);
    });
  });
});
