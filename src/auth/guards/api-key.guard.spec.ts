import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  API_KEY_ENV_METADATA,
  INTERNAL_PLATFORM_API_KEY_ENV,
} from '../decorators/internal-platform-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  function context(apiKey?: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-api-key': apiKey } }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  function guard(isPublic: boolean, apiKeyEnvironment?: string): ApiKeyGuard {
    return new ApiKeyGuard({
      getAllAndOverride: jest.fn((metadata: string) => {
        if (metadata === IS_PUBLIC_KEY) return isPublic;
        if (metadata === API_KEY_ENV_METADATA) return apiKeyEnvironment;
        return undefined;
      }),
    } as unknown as Reflector);
  }

  it('conserva API_KEY para rutas públicas heredadas', () => {
    process.env.API_KEY = 'legacy-secret';

    expect(guard(true).canActivate(context('legacy-secret'))).toBe(true);
  });

  it('exige INTERNAL_PLATFORM_API_KEY para rutas internas de plataforma', () => {
    process.env.API_KEY = 'legacy-secret';
    process.env.INTERNAL_PLATFORM_API_KEY = 'platform-secret';
    const internalGuard = guard(true, INTERNAL_PLATFORM_API_KEY_ENV);

    expect(internalGuard.canActivate(context('platform-secret'))).toBe(true);
    expect(() => internalGuard.canActivate(context('legacy-secret'))).toThrow(
      UnauthorizedException,
    );
  });

  it('no exige ninguna llave cuando la ruta no es pública', () => {
    expect(guard(false).canActivate(context())).toBe(true);
  });
});
