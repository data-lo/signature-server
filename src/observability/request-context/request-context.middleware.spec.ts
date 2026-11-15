import type { Request, Response } from 'express';

import {
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
} from './request-context.constants';
import { RequestContext } from './request-context.interface';
import {
  initialPathOf,
  RequestContextMiddleware,
  resolveRequestId,
} from './request-context.middleware';
import { RequestContextService } from './request-context.service';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each([
    'erp-20261114-7f3c2a9d',
    '0b3f7c2e-9a51-4f0e-8d2c-1e6b5a4c3d2f',
    '01HZX3J8Q7K2M5N6P8R9S0T1V2',
    'svc.erp:2026-11-14_0001',
    'a',
    'x'.repeat(REQUEST_ID_MAX_LENGTH),
  ])('acepta %s', (value) => {
    expect(resolveRequestId(value)).toBe(value);
  });

  it.each([
    ['ausente', undefined],
    ['vacío', ''],
    ['demasiado largo', 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1)],
    ['con espacios', 'req 1'],
    ['repetido (Node lo une con ", ")', 'req-1, req-2'],
    ['con salto de línea', 'req-1\nlevel=error'],
    ['con comillas', '"req-1"'],
    ['con barra', 'req/1'],
    ['con signo igual', 'Root=1-67891233-abcdef0123'],
    ['no ASCII', 'petición-1'],
    ['como arreglo', ['req-1', 'req-2']],
  ])('genera un UUID si es %s', (_, value) => {
    const result = resolveRequestId(value as string | string[] | undefined);
    expect(result).toMatch(UUID_V4);
  });

  it('genera uno distinto cada vez', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});

describe('initialPathOf', () => {
  it.each([
    ['/api/v1/integration/documents', '/api/v1/integration/documents'],
    [
      '/api/v1/integration/users/documents?email=ana@correo.test',
      '/api/v1/integration/users/documents',
    ],
    ['/api/v1/docs#/x', '/api/v1/docs'],
    ['/', '/'],
  ])('%s → %s', (url, path) => {
    expect(initialPathOf(url)).toBe(path);
  });
});

describe('RequestContextMiddleware', () => {
  const service = new RequestContextService();
  const middleware = new RequestContextMiddleware(service);

  /** Petición mínima con los headers dados. */
  function requestWith(headers: Record<string, string> = {}): Request {
    return {
      method: 'POST',
      originalUrl: '/api/v1/integration/users/documents?email=ana@correo.test',
      url: '/integration/users/documents?email=ana@correo.test',
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
      body: { payload: '{"participants":[{"email":"ana@correo.test"}]}' },
    } as unknown as Request;
  }

  /** Corre el middleware y devuelve el header escrito y el contexto que vio `next`. */
  function run(request: Request) {
    const setHeader = jest.fn();
    let seen: RequestContext | undefined;
    middleware.use(request, { setHeader } as unknown as Response, () => {
      seen = service.get();
    });
    return { setHeader, seen: seen! };
  }

  it('respeta un X-Request-Id válido y lo devuelve en la respuesta', () => {
    const { setHeader, seen } = run(
      requestWith({ 'X-Request-Id': 'erp-20261114-7f3c2a9d' }),
    );
    expect(setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      'erp-20261114-7f3c2a9d',
    );
    expect(seen.requestId).toBe('erp-20261114-7f3c2a9d');
  });

  it('genera uno nuevo si el recibido es inválido', () => {
    const { setHeader, seen } = run(
      requestWith({ 'X-Request-Id': 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1) }),
    );
    expect(seen.requestId).toMatch(UUID_V4);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, seen.requestId);
  });

  it('genera uno nuevo si no viene', () => {
    const { setHeader, seen } = run(requestWith());
    expect(seen.requestId).toMatch(UUID_V4);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, seen.requestId);
  });

  it('el contexto tiene sólo requestId, método, ruta sin query y timestamp', () => {
    const { seen } = run(requestWith({ 'X-Request-Id': 'req-1' }));
    expect(Object.keys(seen).sort()).toEqual(
      ['method', 'path', 'requestId', 'startedAt'].sort(),
    );
    expect(seen).toEqual({
      requestId: 'req-1',
      method: 'POST',
      path: '/api/v1/integration/users/documents',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it('no copia API key, Authorization, traceparent, query ni body', () => {
    const { seen } = run(
      requestWith({
        'X-API-Key': 'fma_live_0123456789abcdef_secretoSecretoSecreto',
        Authorization: 'Bearer eyJhbGciOi',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'X-Correlation-Id': 'corr-1',
      }),
    );
    const json = JSON.stringify(seen);
    for (const leaked of [
      'fma_live_',
      'Bearer',
      '4bf92f3577b34da6',
      'corr-1',
      'ana@correo.test',
      'participants',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it('el contexto está congelado', () => {
    const { seen } = run(requestWith());
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('el header se escribe antes de continuar la cadena', () => {
    const order: string[] = [];
    middleware.use(
      requestWith(),
      { setHeader: () => order.push('header') } as unknown as Response,
      () => order.push('next'),
    );
    expect(order).toEqual(['header', 'next']);
  });

  it('fuera del middleware no queda contexto', () => {
    run(requestWith());
    expect(service.get()).toBeUndefined();
  });
});
