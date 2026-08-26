import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from '../user.service';
import { CompleteMyOnboardingUseCase } from './complete-my-onboarding.use-case';

describe('CompleteMyOnboardingUseCase', () => {
  let useCase: CompleteMyOnboardingUseCase;
  let userService: {
    findOneWithPersonalInformation: jest.Mock;
    markConfigured: jest.Mock;
    refreshCurpCache: jest.Mock;
  };

  const readyUser = {
    id: 'user-1',
    nationalId: 'CURP1',
    signatureId: 'signature-1',
    personalInformation: {
      phoneNumber: '5512345678',
      secondaryEmail: 'secundario@correo.com',
    },
  };

  beforeEach(async () => {
    userService = {
      findOneWithPersonalInformation: jest.fn().mockResolvedValue(readyUser),
      markConfigured: jest.fn().mockResolvedValue(undefined),
      refreshCurpCache: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompleteMyOnboardingUseCase,
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    useCase = module.get(CompleteMyOnboardingUseCase);
  });

  it('fija isConfigured=true y refresca el cache de Redis por CURP', async () => {
    const result = await useCase.execute('user-1', {} as never);

    expect(userService.markConfigured).toHaveBeenCalledWith('user-1');
    expect(userService.refreshCurpCache).toHaveBeenCalledWith(
      readyUser,
      readyUser.personalInformation,
    );
    expect(result.data).toEqual({ isConfigured: true });
  });

  it('lanza NotFoundException si el usuario no existe', async () => {
    userService.findOneWithPersonalInformation.mockResolvedValue(null);

    await expect(useCase.execute('missing-user', {} as never)).rejects.toThrow(
      NotFoundException,
    );
    expect(userService.markConfigured).not.toHaveBeenCalled();
  });

  /**
   * Bug corregido (README, Historia 2): antes bastaba con llamar al endpoint para quedar
   * configurado, sin importar el estado real de los datos. Lo que manda el DTO es irrelevante.
   */
  it('bug corregido: lanza BadRequestException si falta informacion personal, sin importar lo que mande el DTO', async () => {
    userService.findOneWithPersonalInformation.mockResolvedValue({
      ...readyUser,
      personalInformation: { phoneNumber: '5512345678', secondaryEmail: null },
    });

    await expect(
      useCase.execute('user-1', { isConfigured: true } as never),
    ).rejects.toThrow(BadRequestException);
    expect(userService.markConfigured).not.toHaveBeenCalled();
  });

  it('bug corregido: lanza BadRequestException si falta la firma digital (signatureId nulo)', async () => {
    userService.findOneWithPersonalInformation.mockResolvedValue({
      ...readyUser,
      signatureId: null,
    });

    await expect(useCase.execute('user-1', {} as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(userService.markConfigured).not.toHaveBeenCalled();
  });

  /** El snapshot cacheado tiene que salir de lo que quedó escrito, no de la copia previa. */
  it('relee el usuario despues de escribir para construir el snapshot', async () => {
    const afterUpdate = { ...readyUser, isConfigured: true };
    userService.findOneWithPersonalInformation
      .mockResolvedValueOnce(readyUser)
      .mockResolvedValueOnce(afterUpdate);

    await useCase.execute('user-1', {} as never);

    expect(userService.findOneWithPersonalInformation).toHaveBeenCalledTimes(2);
    expect(userService.refreshCurpCache).toHaveBeenCalledWith(
      afterUpdate,
      afterUpdate.personalInformation,
    );
  });
});
