import { Test, TestingModule } from '@nestjs/testing';

import { GetUserUseCase } from 'src/user/applications/get-user.use-case';

import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { GetAuthenticatedUserUseCase } from './get-authenticated-user.use-case';

describe('GetAuthenticatedUserUseCase', () => {
  let useCase: GetAuthenticatedUserUseCase;
  let getUser: { execute: jest.Mock };

  beforeEach(async () => {
    getUser = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetAuthenticatedUserUseCase,
        { provide: GetUserUseCase, useValue: getUser },
      ],
    }).compile();

    useCase = module.get(GetAuthenticatedUserUseCase);
  });

  /**
   * El identificador sale del `sub` del JWT. Si viniera de la petición, cualquiera podría leer
   * el perfil de otro usuario cambiando un parámetro.
   */
  it('pide el perfil del sub del token, con archivos incluidos', async () => {
    const profile = { success: true, data: { id: 'user-1' } };
    getUser.execute.mockResolvedValue(profile);

    const result = await useCase.execute({ sub: 'user-1' } as JwtPayload);

    expect(getUser.execute).toHaveBeenCalledWith('user-1', true);
    expect(result).toBe(profile);
  });
});
