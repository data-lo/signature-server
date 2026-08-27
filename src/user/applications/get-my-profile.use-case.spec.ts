import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from '../user.service';
import { GetMyProfileUseCase } from './get-my-profile.use-case';

describe('GetMyProfileUseCase', () => {
  let useCase: GetMyProfileUseCase;
  let userService: {
    readCachedProfile: jest.Mock;
    findActiveByNationalId: jest.Mock;
    buildProfileSnapshot: jest.Mock;
    refreshCurpCache: jest.Mock;
  };

  beforeEach(async () => {
    userService = {
      readCachedProfile: jest.fn().mockResolvedValue(null),
      findActiveByNationalId: jest.fn(),
      buildProfileSnapshot: jest.fn(),
      refreshCurpCache: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMyProfileUseCase,
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    useCase = module.get(GetMyProfileUseCase);
  });

  it('sirve el snapshot cacheado sin consultar PostgreSQL', async () => {
    const cached = { id: 'user-1', isConfigured: true };
    userService.readCachedProfile.mockResolvedValue(cached);

    const result = await useCase.execute('CURP1');

    expect(userService.findActiveByNationalId).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      message: 'Usuario obtenido correctamente',
      data: cached,
    });
  });

  /** Un cache frío es un problema de rendimiento, no un 404. */
  it('reconstruye y recachea el snapshot desde PostgreSQL si la key no existe', async () => {
    const personalInformation = { rfc: 'PELJ850101ABC' };
    const user = { id: 'user-1', nationalId: 'CURP1', personalInformation };
    const snapshot = { id: 'user-1', personalInformation };
    userService.findActiveByNationalId.mockResolvedValue(user);
    userService.buildProfileSnapshot.mockReturnValue(snapshot);

    const result = await useCase.execute('CURP1');

    expect(userService.buildProfileSnapshot).toHaveBeenCalledWith(
      user,
      personalInformation,
    );
    expect(userService.refreshCurpCache).toHaveBeenCalledWith(
      user,
      personalInformation,
    );
    expect(result.data).toBe(snapshot);
  });

  it('lanza NotFoundException si no hay cache ni usuario activo con ese CURP', async () => {
    userService.findActiveByNationalId.mockResolvedValue(null);

    await expect(useCase.execute('CURP1')).rejects.toThrow(NotFoundException);
    expect(userService.refreshCurpCache).not.toHaveBeenCalled();
  });
});
