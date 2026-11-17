import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  function context(apiKey?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-api-key': apiKey } }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  function guard(isPublic: boolean): ApiKeyGuard {
    return new ApiKeyGuard({
      getAllAndOverride: jest.fn((metadata: string) =>
        metadata === IS_PUBLIC_KEY ? isPublic : undefined,
      ),
    } as unknown as Reflector);
  }

  it('conserva API_KEY para rutas públicas heredadas', () => {
    process.env.API_KEY = 'legacy-secret';

    expect(guard(true).canActivate(context('legacy-secret'))).toBe(true);
  });

  it('rechaza una llave distinta de API_KEY en rutas públicas', () => {
    process.env.API_KEY = 'legacy-secret';

    expect(() => guard(true).canActivate(context('otra-llave'))).toThrow(
      UnauthorizedException,
    );
  });

  it('no exige ninguna llave cuando la ruta no es pública', () => {
    expect(guard(false).canActivate(context())).toBe(true);
  });
});
