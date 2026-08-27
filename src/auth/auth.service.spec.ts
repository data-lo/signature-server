import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';

import { RedisService } from '../shared/redis/redis.service';
import { UserEntity } from '../user/entities/user.entity';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: { sign: jest.Mock; verifyAsync: jest.Mock };
  let redisService: { set: jest.Mock; get: jest.Mock };

  const user = {
    id: 'user-1',
    email: 'ana@empresa.com',
    roles: ['signer'],
    nationalId: 'GOMA900101MDFRNN01',
  } as unknown as UserEntity;

  beforeEach(async () => {
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-jwt'),
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        purpose: 'password_reset',
        iat: 1000,
      }),
    };
    redisService = { set: jest.fn(), get: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtService, useValue: jwtService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('signJwtForUser', () => {
    it('arma el payload desde UserEntity', () => {
      const token = service.signJwtForUser(user);

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: 'ana@empresa.com',
          roles: ['signer'],
          nationalId: 'GOMA900101MDFRNN01',
        }),
      );
      expect(token).toBe('signed-jwt');
    });

    /** Sin `jti` por token no habría forma de cerrar una sesión concreta desde logout. */
    it('incluye un jti distinto en cada token', () => {
      service.signJwtForUser(user);
      service.signJwtForUser(user);

      const [[first], [second]] = jwtService.sign.mock.calls;

      expect(first.jti).toEqual(expect.any(String));
      expect(second.jti).not.toBe(first.jti);
    });
  });

  describe('signPasswordResetToken', () => {
    it('marca el propósito y le pone caducidad corta', () => {
      const token = service.signPasswordResetToken('user-1');

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-1', purpose: 'password_reset' },
        { expiresIn: '10m' },
      );
      expect(token).toBe('signed-jwt');
    });
  });

  describe('verifyPasswordResetToken', () => {
    it('devuelve el payload de un token válido', async () => {
      const payload = await service.verifyPasswordResetToken('reset-jwt');

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('reset-jwt');
      expect(payload.sub).toBe('user-1');
    });

    it('rechaza con UnauthorizedException si el token es inválido o expiró', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(
        service.verifyPasswordResetToken('reset-jwt'),
      ).rejects.toThrow(UnauthorizedException);
    });

    /**
     * Los JWT de sesión van firmados con el mismo secreto: sin este chequeo, cualquiera podría
     * cambiar su contraseña presentando su propio token de sesión, sin saber la actual.
     */
    it('rechaza un token que no fue emitido para cambiar la contraseña', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        purpose: 'other',
        iat: 1000,
      });

      await expect(
        service.verifyPasswordResetToken('session-jwt'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('blacklistJwt', () => {
    it('anota el jti con el tiempo que le queda de vida al token', async () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);

      await service.blacklistJwt({
        sub: 'user-1',
        jti: 'jti-1',
        exp: nowInSeconds + 120,
      } as never);

      const [key, value, ttl] = redisService.set.mock.calls[0];

      expect(key).toBe('blacklist:jti-1');
      expect(value).toBe('1');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    /** Un token ya expirado lo rechaza antes la verificación de firma: anotarlo sería basura. */
    it('no escribe nada si el token ya expiró', async () => {
      await service.blacklistJwt({
        sub: 'user-1',
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) - 10,
      } as never);

      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('no escribe nada si el token no trae exp', async () => {
      await service.blacklistJwt({ sub: 'user-1', jti: 'jti-1' } as never);

      expect(redisService.set).not.toHaveBeenCalled();
    });
  });

  describe('invalidación en bloque', () => {
    it('getSessionsValidAfter devuelve null si nunca se invalidaron', async () => {
      expect(await service.getSessionsValidAfter('user-1')).toBeNull();
    });

    it('getSessionsValidAfter devuelve la marca como número', async () => {
      redisService.get.mockResolvedValue('2000');

      expect(await service.getSessionsValidAfter('user-1')).toBe(2000);
      expect(redisService.get).toHaveBeenCalledWith('token_valid_after:user-1');
    });

    it('invalidateSessionsFor fija la marca a ahora con un TTL que sobrevive a cualquier JWT', async () => {
      await service.invalidateSessionsFor('user-1');

      const [key, value, ttl] = redisService.set.mock.calls[0];

      expect(key).toBe('token_valid_after:user-1');
      expect(Number(value)).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
      expect(ttl).toBe(60 * 60 * 24 * 30);
    });
  });
});
