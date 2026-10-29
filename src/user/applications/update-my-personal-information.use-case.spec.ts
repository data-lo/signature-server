import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from '../user.service';
import { UpdateMyPersonalInformationUseCase } from './update-my-personal-information.use-case';

describe('UpdateMyPersonalInformationUseCase', () => {
  let useCase: UpdateMyPersonalInformationUseCase;
  let userService: {
    findOneWithPersonalInformation: jest.Mock;
    savePersonalInformation: jest.Mock;
    refreshCurpCache: jest.Mock;
  };

  const user = {
    id: 'user-1',
    nationalId: 'CURP1',
    personalInformationId: 'pi-1',
  };
  const dto = {
    phoneNumber: '5512345678',
    secondaryEmail: 'secundario@correo.com',
  };

  beforeEach(async () => {
    userService = {
      findOneWithPersonalInformation: jest.fn().mockResolvedValue(user),
      savePersonalInformation: jest
        .fn()
        .mockResolvedValue({ id: 'pi-1', ...dto }),
      refreshCurpCache: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateMyPersonalInformationUseCase,
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    useCase = module.get(UpdateMyPersonalInformationUseCase);
  });

  it('actualiza los campos y devuelve la fila releida', async () => {
    const result = await useCase.execute('user-1', dto);

    expect(userService.savePersonalInformation).toHaveBeenCalledWith(
      'pi-1',
      dto,
    );
    expect(result.data.phoneNumber).toBe('5512345678');
  });

  /**
   * Estos campos viajan dentro del snapshot de `GET /users/me`: sin refrescar el cache el
   * usuario seguiría viendo los datos viejos y creería que el guardado no funcionó.
   */
  it('refresca el cache de Redis por CURP con la fila ya actualizada', async () => {
    const updated = { id: 'pi-1', ...dto };
    userService.savePersonalInformation.mockResolvedValue(updated);

    await useCase.execute('user-1', dto);

    expect(userService.refreshCurpCache).toHaveBeenCalledWith(user, updated);
  });

  it('lanza NotFoundException si el usuario no existe', async () => {
    userService.findOneWithPersonalInformation.mockResolvedValue(null);

    await expect(useCase.execute('missing-user', dto)).rejects.toThrow(
      NotFoundException,
    );
    expect(userService.savePersonalInformation).not.toHaveBeenCalled();
  });
});
