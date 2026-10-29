import { Test, TestingModule } from '@nestjs/testing';

import { AuthService } from '../auth.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { LogoutUseCase } from './logout.use-case';

describe('LogoutUseCase', () => {
  let useCase: LogoutUseCase;
  let authService: {
    blacklistJwt: jest.Mock;
    invalidateSessionsFor: jest.Mock;
  };

  const payload = {
    sub: 'user-1',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  } as JwtPayload;

  beforeEach(async () => {
    authService = {
      blacklistJwt: jest.fn().mockResolvedValue(undefined),
      invalidateSessionsFor: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LogoutUseCase,
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    useCase = module.get(LogoutUseCase);
  });

  it('cierra la sesion del token con el que se llamo', async () => {
    const result = await useCase.execute(payload);

    expect(authService.blacklistJwt).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      success: true,
      message: 'Sesión cerrada correctamente',
      data: null,
    });
  });

  /**
   * Cerrar sesión en un dispositivo no debe echar a la persona de los demás: la expulsión en
   * bloque existe aparte y sólo la dispara el cambio de contraseña.
   */
  it('no invalida las demas sesiones del usuario', async () => {
    await useCase.execute(payload);

    expect(authService.invalidateSessionsFor).not.toHaveBeenCalled();
  });
});
