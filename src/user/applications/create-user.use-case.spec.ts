import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserRoles } from '../enums/user-roles';
import { UserService } from '../user.service';
import { CreateUserUseCase } from './create-user.use-case';

describe('CreateUserUseCase', () => {
  let useCase: CreateUserUseCase;
  let userService: {
    assertEmailNotTaken: jest.Mock;
    assertCurpNotTaken: jest.Mock;
    assertRfcNotTaken: jest.Mock;
    saveNewUser: jest.Mock;
    sanitize: jest.Mock;
  };

  const dto = {
    firstName: 'Juan',
    lastName: 'Pérez',
    email: 'Juan.Perez@Empresa.com',
    roles: [UserRoles.SIGNER],
    nationalId: 'pelj850101hdfrnn08',
    rfc: 'pelj850101abc',
  };

  beforeEach(async () => {
    userService = {
      assertEmailNotTaken: jest.fn().mockResolvedValue(undefined),
      assertCurpNotTaken: jest.fn().mockResolvedValue(undefined),
      assertRfcNotTaken: jest.fn().mockResolvedValue(undefined),
      saveNewUser: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', password: 'hashed' }),
      sanitize: jest.fn(({ password: _password, ...rest }) => rest),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateUserUseCase,
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    useCase = module.get(CreateUserUseCase);
  });

  it('comprueba las tres unicidades y guarda el usuario', async () => {
    const result = await useCase.execute(dto);

    expect(userService.assertEmailNotTaken).toHaveBeenCalledWith(
      'Juan.Perez@Empresa.com',
    );
    expect(userService.assertCurpNotTaken).toHaveBeenCalledWith(
      'PELJ850101HDFRNN08',
    );
    expect(userService.assertRfcNotTaken).toHaveBeenCalledWith('PELJ850101ABC');
    expect(userService.saveNewUser).toHaveBeenCalledWith(dto);
    expect(result.success).toBe(true);
  });

  it('no filtra la contrasena en la respuesta', async () => {
    const result = await useCase.execute(dto);

    expect(userService.sanitize).toHaveBeenCalled();
    expect(
      (result.data as never as { password?: string }).password,
    ).toBeUndefined();
  });

  /** Abrir una transacción que se sabe condenada sólo cambiaría el 409 por un error de Postgres. */
  it('no intenta guardar si el correo ya esta registrado', async () => {
    userService.assertEmailNotTaken.mockRejectedValue(
      new ConflictException(
        'Ya existe un usuario registrado con ese correo electrónico',
      ),
    );

    await expect(useCase.execute(dto)).rejects.toThrow(ConflictException);
    expect(userService.saveNewUser).not.toHaveBeenCalled();
  });

  it('no intenta guardar si el CURP ya esta en uso', async () => {
    userService.assertCurpNotTaken.mockRejectedValue(new ConflictException());

    await expect(useCase.execute(dto)).rejects.toThrow(ConflictException);
    expect(userService.saveNewUser).not.toHaveBeenCalled();
  });

  it('no intenta guardar si el RFC ya esta en uso', async () => {
    userService.assertRfcNotTaken.mockRejectedValue(new ConflictException());

    await expect(useCase.execute(dto)).rejects.toThrow(ConflictException);
    expect(userService.saveNewUser).not.toHaveBeenCalled();
  });

  it('omite las comprobaciones de CURP y RFC si el dto no los trae', async () => {
    await useCase.execute({
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@empresa.com',
    } as never);

    expect(userService.assertCurpNotTaken).not.toHaveBeenCalled();
    expect(userService.assertRfcNotTaken).not.toHaveBeenCalled();
    expect(userService.saveNewUser).toHaveBeenCalled();
  });
});
