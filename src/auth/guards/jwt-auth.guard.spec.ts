import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RedisService } from '../../shared/redis/redis.service';

function buildContext(headers: Record<string, string> = {}): ExecutionContext {
  const request = { headers, user: undefined };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let jwtService: { verifyAsync: jest.Mock };
  let redisService: { exists: jest.Mock; get: jest.Mock };

  const basePayload = {
    sub: 'user-1',
    email: 'ana@empresa.com',
    roles: ['signer'],
    nationalId: 'GOMA900101MDFRNN01',
    jti: 'jti-1',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    jwtService = { verifyAsync: jest.fn().mockResolvedValue(basePayload) };
    redisService = {
      exists: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
    };

    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      jwtService as unknown as JwtService,
      redisService as unknown as RedisService,
    );
  });

  it('deja pasar rutas @Public()/@SkipJwtAuth() sin verificar nada', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);

    const result = await guard.canActivate(buildContext());

    expect(result).toBe(true);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rechaza si no hay header Authorization', async () => {
    await expect(guard.canActivate(buildContext())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si el token es inválido o expiró', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      guard.canActivate(buildContext({ authorization: 'Bearer bad-token' })),
    ).rejects.toThrow('Token inválido o expirado');
  });

  it('rechaza si el jti está en la blacklist (logout)', async () => {
    redisService.exists.mockResolvedValue(1);

    await expect(
      guard.canActivate(buildContext({ authorization: 'Bearer good-token' })),
    ).rejects.toThrow('La sesión ha sido cerrada');
    expect(redisService.exists).toHaveBeenCalledWith('blacklist:jti-1');
  });

  it('bug corregido: rechaza si el token se emitió antes de token_valid_after (invalidación en bloque tras reset de contraseña)', async () => {
    redisService.get.mockResolvedValue(String(basePayload.iat + 100));

    await expect(
      guard.canActivate(buildContext({ authorization: 'Bearer good-token' })),
    ).rejects.toThrow('La sesión ha sido cerrada');
    expect(redisService.get).toHaveBeenCalledWith('token_valid_after:user-1');
  });

  it('acepta un token válido sin blacklist ni marca de invalidación', async () => {
    const context = buildContext({ authorization: 'Bearer good-token' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(context.switchToHttp().getRequest().user).toEqual(basePayload);
  });

  it('acepta un token emitido DESPUÉS de token_valid_after', async () => {
    redisService.get.mockResolvedValue(String(basePayload.iat - 100));

    const result = await guard.canActivate(
      buildContext({ authorization: 'Bearer good-token' }),
    );

    expect(result).toBe(true);
  });
});
