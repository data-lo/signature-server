import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from '../user.service';
import { CheckRfcAvailabilityUseCase } from './check-rfc-availability.use-case';
import { ListUsersUseCase } from './list-users.use-case';
import { GetUserUseCase } from './get-user.use-case';
import { UpdateUserUseCase } from './update-user.use-case';
import { DeleteUserUseCase } from './delete-user.use-case';

describe('casos de uso de lectura y escritura de usuarios', () => {
  let userService: {
    isRfcRegistered: jest.Mock;
    listActiveUsers: jest.Mock;
    getActiveUserProfile: jest.Mock;
    applyUserUpdate: jest.Mock;
    softDelete: jest.Mock;
  };
  let checkRfcAvailability: CheckRfcAvailabilityUseCase;
  let listUsers: ListUsersUseCase;
  let getUser: GetUserUseCase;
  let updateUser: UpdateUserUseCase;
  let deleteUser: DeleteUserUseCase;

  beforeEach(async () => {
    userService = {
      isRfcRegistered: jest.fn().mockResolvedValue(false),
      listActiveUsers: jest.fn().mockResolvedValue([]),
      getActiveUserProfile: jest.fn().mockResolvedValue({ id: 'user-1' }),
      applyUserUpdate: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckRfcAvailabilityUseCase,
        ListUsersUseCase,
        GetUserUseCase,
        UpdateUserUseCase,
        DeleteUserUseCase,
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    checkRfcAvailability = module.get(CheckRfcAvailabilityUseCase);
    listUsers = module.get(ListUsersUseCase);
    getUser = module.get(GetUserUseCase);
    updateUser = module.get(UpdateUserUseCase);
    deleteUser = module.get(DeleteUserUseCase);
  });

  describe('CheckRfcAvailabilityUseCase', () => {
    it('retorna exists:true si el RFC ya tiene cuenta', async () => {
      userService.isRfcRegistered.mockResolvedValue(true);

      const result = await checkRfcAvailability.execute('pelj850101abc');

      expect(userService.isRfcRegistered).toHaveBeenCalledWith('pelj850101abc');
      expect(result.data).toEqual({ exists: true });
    });

    /** El RFC es público: decir a quién pertenece convertiría esto en un buscador de personas. */
    it('solo expone el booleano, nunca de quien es el RFC', async () => {
      userService.isRfcRegistered.mockResolvedValue(true);

      const result = await checkRfcAvailability.execute('pelj850101abc');

      expect(Object.keys(result.data)).toEqual(['exists']);
    });

    it('retorna exists:false si el RFC esta libre', async () => {
      expect(
        (await checkRfcAvailability.execute('XAXX010101000')).data,
      ).toEqual({ exists: false });
    });
  });

  describe('ListUsersUseCase', () => {
    it('propaga withSignature al servicio', async () => {
      await listUsers.execute(true);

      expect(userService.listActiveUsers).toHaveBeenCalledWith(true);
    });

    /** Que no haya nadie registrado es un estado válido, no un fallo que el cliente deba manejar. */
    it('una lista vacia sigue siendo success con su propio mensaje', async () => {
      const result = await listUsers.execute();

      expect(result).toEqual({
        success: true,
        message: 'No hay usuarios registrados',
        data: [],
      });
    });

    it('con usuarios devuelve el mensaje de exito habitual', async () => {
      userService.listActiveUsers.mockResolvedValue([{ id: 'user-1' }]);

      const result = await listUsers.execute();

      expect(result.message).toBe('Usuarios obtenidos correctamente');
    });
  });

  describe('GetUserUseCase', () => {
    it('devuelve el perfil envuelto en la respuesta estandar', async () => {
      const profile = { id: 'user-1', rfc: 'PELJ850101ABC' };
      userService.getActiveUserProfile.mockResolvedValue(profile);

      const result = await getUser.execute('user-1', true);

      expect(userService.getActiveUserProfile).toHaveBeenCalledWith(
        'user-1',
        true,
      );
      expect(result).toEqual({
        success: true,
        message: 'Usuario obtenido correctamente',
        data: profile,
      });
    });

    it('no pide los archivos si no se solicita withSignature', async () => {
      await getUser.execute('user-1');

      expect(userService.getActiveUserProfile).toHaveBeenCalledWith(
        'user-1',
        false,
      );
    });

    it('propaga el NotFoundException del usuario inexistente', async () => {
      userService.getActiveUserProfile.mockRejectedValue(
        new NotFoundException('Usuario con ID missing-user no encontrado'),
      );

      await expect(getUser.execute('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('UpdateUserUseCase', () => {
    it('escribe y despues relee el perfil, para responder con lo que quedo guardado', async () => {
      const dto = { firstName: 'Juan' };

      const result = await updateUser.execute('user-1', dto);

      expect(userService.applyUserUpdate).toHaveBeenCalledWith('user-1', dto);
      expect(userService.getActiveUserProfile).toHaveBeenCalledWith(
        'user-1',
        false,
      );
      expect(result.message).toBe('Usuario actualizado correctamente');
    });
  });

  describe('DeleteUserUseCase', () => {
    it('da de baja logica al usuario', async () => {
      const result = await deleteUser.execute('user-1');

      expect(userService.softDelete).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({
        success: true,
        message: 'Usuario eliminado correctamente',
      });
    });

    it('propaga el NotFoundException si no habia usuario activo con ese id', async () => {
      userService.softDelete.mockRejectedValue(new NotFoundException());

      await expect(deleteUser.execute('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
