import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PasswordService } from 'src/common/password/password.service';
import { TurnstileService } from 'src/common/turnstile/turnstile.service';
import { UserService } from 'src/user/user.service';

import { RegisterUseCase } from './register.use-case';

describe('RegisterUseCase', () => {
  let useCase: RegisterUseCase;
  let userService: { createFromSignup: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let turnstileService: { verifyToken: jest.Mock };

  const dto = {
    firstName: 'Ana',
    lastName: 'Gómez',
    email: 'ana@empresa.com',
    nationalId: 'GOMA900101MDFRNN01',
    rfc: 'GOMA900101XYZ',
    password: 'Password123!',
    confirmPassword: 'Password123!',
    turnstileToken: '0.token-del-widget',
  };
  const pendingVerificationData = {
    userId: 'user-1',
    email: 'ana@empresa.com',
    maskedEmail: 'a***a@empresa.com',
    isNewPreRegistration: true,
  };

  beforeEach(async () => {
    userService = {
      createFromSignup: jest
        .fn()
        .mockResolvedValue({ success: true, data: pendingVerificationData }),
    };
    passwordService = { hash: jest.fn().mockResolvedValue('hashed-pw') };
    turnstileService = { verifyToken: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterUseCase,
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
        { provide: TurnstileService, useValue: turnstileService },
      ],
    }).compile();

    useCase = module.get(RegisterUseCase);
  });

  it('hashea el password y delega en userService.createFromSignup', async () => {
    await useCase.execute(dto as never);

    expect(passwordService.hash).toHaveBeenCalledWith('Password123!');
    expect(userService.createFromSignup).toHaveBeenCalledWith(dto, 'hashed-pw');
  });

  it('verifica el CAPTCHA de Turnstile antes de crear el pre-registro', async () => {
    await useCase.execute(dto as never);

    expect(turnstileService.verifyToken).toHaveBeenCalledWith(
      '0.token-del-widget',
    );
  });

  // El punto entero de la historia: un token rechazado no debe dejar rastro — ni pre-registro,
  // ni hash de contraseña, ni OTP enviado.
  it('no crea ni actualiza el pre-registro si el CAPTCHA no es valido', async () => {
    turnstileService.verifyToken.mockRejectedValue(
      new BadRequestException('CAPTCHA inválido'),
    );

    await expect(useCase.execute(dto as never)).rejects.toThrow(
      BadRequestException,
    );

    expect(userService.createFromSignup).not.toHaveBeenCalled();
    expect(passwordService.hash).not.toHaveBeenCalled();
  });

  /**
   * Historia "Unificar invitaciones de miembros y vincular cuentas nuevas por token": el registro
   * ya no acepta invitaciones. Un token que llegue en el cuerpo —de un cliente anterior— se
   * ignora y la cuenta se crea igual; unirse a la organización es una llamada aparte que el
   * frontend hace después, a `POST /organizations/invitations/:token/accept`. El módulo de
   * prueba ni siquiera provee `OrganizationInvitationService`: si el caso de uso volviera a
   * depender de él, esta suite dejaría de compilar.
   */
  it('crea la cuenta sin aceptar ninguna invitación, aunque llegue un token', async () => {
    const result = await useCase.execute({
      ...dto,
      invitationToken: 'invite-token-1',
    } as never);

    expect(result.success).toBe(true);
    expect(userService.createFromSignup).toHaveBeenCalledTimes(1);
  });
});
