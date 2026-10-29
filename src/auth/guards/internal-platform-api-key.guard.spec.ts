import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { InternalPlatformAuth } from '../decorators/internal-platform-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_SKIP_JWT_KEY } from '../decorators/skip-jwt-auth.decorator';
import { InternalPlatformApiKeyGuard } from './internal-platform-api-key.guard';

const INTERNAL_KEY = 'llave-interna-de-plataforma-con-mas-de-32-caracteres';

describe('InternalPlatformApiKeyGuard', () => {
  function guardWith(value: string | undefined) {
    return new InternalPlatformApiKeyGuard({
      get: () => value,
    } as unknown as ConfigService);
  }

  function context(headers: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  it('deja pasar la llave interna correcta', () => {
    expect(
      guardWith(INTERNAL_KEY).canActivate(
        context({ 'x-api-key': INTERNAL_KEY }),
      ),
    ).toBe(true);
  });

  it.each([
    ['sin header', {}],
    ['con otra llave', { 'x-api-key': `${INTERNAL_KEY}-otra` }],
    ['con la llave en otro header', { authorization: INTERNAL_KEY }],
    ['con un arreglo', { 'x-api-key': [INTERNAL_KEY] }],
  ])('rechaza con 401 %s', (_label, headers) => {
    expect(() => guardWith(INTERNAL_KEY).canActivate(context(headers))).toThrow(
      UnauthorizedException,
    );
  });

  /** Falla cerrado: sin configuración no se acepta nada, ni siquiera un header vacío. */
  it.each([
    ['sin configurar', undefined],
    ['vacía', ''],
    ['demasiado corta', 'corta'],
  ])('responde 503 con la variable %s', (_label, value) => {
    expect(() =>
      guardWith(value).canActivate(context({ 'x-api-key': value ?? '' })),
    ).toThrow(ServiceUnavailableException);
  });

  it('no deja la llave recibida en el mensaje del error', () => {
    const received = 'llave-equivocada-que-no-debe-aparecer-en-ningun-lado';
    try {
      guardWith(INTERNAL_KEY).canActivate(context({ 'x-api-key': received }));
      fail('debía rechazar');
    } catch (error) {
      expect(
        JSON.stringify((error as UnauthorizedException).getResponse()),
      ).not.toContain(received);
    }
  });
});

describe('@InternalPlatformAuth()', () => {
  @InternalPlatformAuth()
  class DecoratedController {}

  const reflector = new Reflector();

  it('salta el JWT y monta el guard interno', () => {
    expect(reflector.get(IS_SKIP_JWT_KEY, DecoratedController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, DecoratedController)).toEqual([
      InternalPlatformApiKeyGuard,
    ]);
  });

  /** Con `@Public()`, el `ApiKeyGuard` global aceptaría la llave compartida `API_KEY`. */
  it('no marca la ruta como @Public()', () => {
    expect(reflector.get(IS_PUBLIC_KEY, DecoratedController)).toBeUndefined();
  });
});
