import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PasswordService } from 'src/shared/password/password.service';
import { UserService } from 'src/user/user.service';

import { UpdatePreRegistrationUseCase } from './update-pre-registration.use-case';

/**
 * Corrección de datos antes de verificar el correo. Lo que se prueba aquí es la autorización:
 * el OTP no sirve como prueba de identidad cuando el error está justamente en el correo (nunca
 * llegó), así que la operación se autoriza con la contraseña del propio pre-registro. Sin ese
 * requisito, conocer un CURP ajeno —que no es secreto— bastaría para redirigir el registro de
 * otra persona a un correo propio.
 */
describe('UpdatePreRegistrationUseCase', () => {
  let useCase: UpdatePreRegistrationUseCase;
  let userService: {
    findOneByEmail: jest.Mock;
    updatePreRegistration: jest.Mock;
  };
  let passwordService: { compare: jest.Mock };

  const dto = {
    currentEmail: 'ANA@empresa.con',
    password: 'supersecret123',
    email: 'ana@empresa.com',
  };
  const pendingUser = {
    id: 'user-1',
    email: 'ana@empresa.con',
    password: 'hashed-pw',
    isEmailVerified: false,
  };

  beforeEach(async () => {
    userService = {
      findOneByEmail: jest.fn().mockResolvedValue(pendingUser),
      updatePreRegistration: jest.fn().mockResolvedValue({
        success: true,
        message: 'ok',
        data: {
          userId: 'user-1',
          email: 'ana@empresa.com',
          maskedEmail: 'a***a@empresa.com',
          isNewPreRegistration: false,
        },
      }),
    };
    passwordService = { compare: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdatePreRegistrationUseCase,
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
      ],
    }).compile();

    useCase = module.get(UpdatePreRegistrationUseCase);
  });

  it('con la contrasena correcta, delega la correccion de los datos', async () => {
    const result = await useCase.execute(dto as never);

    expect(userService.findOneByEmail).toHaveBeenCalledWith('ana@empresa.con');
    expect(passwordService.compare).toHaveBeenCalledWith(
      'supersecret123',
      pendingUser.password,
    );
    expect(userService.updatePreRegistration).toHaveBeenCalledWith(
      pendingUser,
      {
        email: 'ana@empresa.com',
        firstName: undefined,
        lastName: undefined,
        nationalId: undefined,
        rfc: undefined,
      },
    );
    expect(result.data.email).toBe('ana@empresa.com');
  });

  it('con la contrasena incorrecta, rechaza sin tocar los datos', async () => {
    passwordService.compare.mockResolvedValue(false);

    await expect(useCase.execute(dto as never)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userService.updatePreRegistration).not.toHaveBeenCalled();
  });

  it('si no existe un registro con ese correo responde igual que con la contrasena incorrecta, para no revelar que correos estan registrados', async () => {
    userService.findOneByEmail.mockResolvedValue(null);

    await expect(useCase.execute(dto as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('una cuenta ya verificada no se edita por esta via publica, aunque la contrasena sea correcta', async () => {
    userService.findOneByEmail.mockResolvedValue({
      ...pendingUser,
      isEmailVerified: true,
    });

    await expect(useCase.execute(dto as never)).rejects.toThrow(
      ConflictException,
    );
    expect(userService.updatePreRegistration).not.toHaveBeenCalled();
  });
});
