import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

import { RequestContextService } from '../request-context/request-context.service';
import { annotateIntegrationAccess } from './integration-access-log.annotations';
import { IntegrationAccessLogEvent } from './integration-access-log.interface';
import {
  IntegrationAccessLogMiddleware,
  isIntegrationApiPath,
  resolveAccessLogIp,
  routeTemplateOf,
} from './integration-access-log.middleware';
import { IntegrationAccessLogger } from './integration-access.logger';

describe('isIntegrationApiPath', () => {
  it.each([
    ['/api/v1/integration', true],
    ['/api/v1/integration/documents', true],
    ['/api/v1/integration/documents?page=2', true],
    ['/API/V1/Integration/documents', true],
    ['/api/v1/integration/no-existe', true],
    ['/api/v1/integration/docs', false],
    ['/api/v1/integration/docs/', false],
    ['/api/v1/integration/docs-json', false],
    ['/api/v1/integration/docs/swagger-ui.css', false],
    ['/api/v1/integration/documents-docs', true],
    ['/api/v1/integration-settings', false],
    ['/api/v1/organizations/1/integration-settings', false],
    ['/api/v1/documents', false],
    ['/health', false],
  ])('%s → %s', (url, expected) => {
    expect(isIntegrationApiPath(url)).toBe(expected);
  });
});

describe('routeTemplateOf', () => {
  it.each([
    [
      { path: '/api/v1/integration/documents' },
      '/api/v1/integration/documents',
    ],
    [
      { path: '/integration/documents/:documentId' },
      '/api/v1/integration/documents/:documentId',
    ],
    [undefined, 'unmatched'],
  ])('%j → %s', (route, expected) => {
    expect(routeTemplateOf({ route } as Request)).toBe(expected);
  });
});

describe('resolveAccessLogIp', () => {
  it('prefiere la clientIp de RequestIpInterceptor si es una IP', () => {
    expect(
      resolveAccessLogIp({ clientIp: '203.0.113.7', ip: '10.0.0.1' } as never),
    ).toBe('203.0.113.7');
  });

  it('sin clientIp válida usa la IP de Express o del socket, nunca headers', () => {
    expect(
      resolveAccessLogIp({ clientIp: 'UNKNOWN', ip: '::1' } as never),
    ).toBe('::1');
    expect(
      resolveAccessLogIp({
        clientIp: '1.1.1.1, 2.2.2.2',
        socket: { remoteAddress: '10.0.0.9' },
      } as never),
    ).toBe('10.0.0.9');
  });

  it('null si no hay ninguna IP válida', () => {
    expect(resolveAccessLogIp({} as never)).toBeNull();
  });
});

describe('IntegrationAccessLogMiddleware', () => {
  const requestContext = new RequestContextService();
  let events: IntegrationAccessLogEvent[];
  let middleware: IntegrationAccessLogMiddleware;

  beforeEach(() => {
    events = [];
    const logger = {
      log: (event: IntegrationAccessLogEvent) => events.push(event),
    } as unknown as IntegrationAccessLogger;
    middleware = new IntegrationAccessLogMiddleware(requestContext, logger);
  });

  /** Respuesta mínima que emite `close`. */
  function fakeResponse(statusCode = 200, finished = true) {
    const emitter = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    emitter.statusCode = statusCode;
    emitter.writableFinished = finished;
    emitter.getHeader = () => 'req-del-header';
    return emitter as unknown as Response & EventEmitter;
  }

  function fakeRequest(overrides: Record<string, unknown> = {}) {
    return {
      method: 'POST',
      originalUrl:
        '/api/v1/integration/documents/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b/signing-access',
      headers: {
        'x-api-key':
          'fma_live_0123456789abcdef_EjemploNoRealEjemploNoRealEjemploNoRea',
        authorization: 'Bearer eyJ',
        cookie: 'session=abc',
        'idempotency-key': 'idem-secreta-123',
      },
      body: { email: 'ana@correo.test', firstName: 'Ana' },
      route: {
        path: '/api/v1/integration/documents/:documentId/signing-access',
      },
      params: { documentId: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b' },
      apiClient: {
        apiKeyId: '0b3f7c2e-9a51-4f0e-8d2c-1e6b5a4c3d2f',
        organizationId: '7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6',
        apiKeyName: 'Integración ERP',
      },
      clientIp: '203.0.113.7',
      ...overrides,
    } as unknown as Request;
  }

  function run(request: Request, response: Response & EventEmitter) {
    requestContext.run(
      {
        requestId: 'req-ctx-1',
        method: request.method,
        path: '/x',
        startedAt: new Date().toISOString(),
      },
      () => middleware.use(request, response, () => undefined),
    );
  }

  it('no escribe nada hasta que la respuesta se cierra, y entonces una sola vez', () => {
    const response = fakeResponse(200);
    run(fakeRequest(), response);
    expect(events).toHaveLength(0);
    response.emit('close');
    response.emit('close');
    expect(events).toHaveLength(1);
  });

  it('toma requestId del contexto, apiClient, documentId de la ruta e IP', () => {
    const response = fakeResponse(200);
    run(fakeRequest(), response);
    response.emit('close');
    expect(events[0]).toEqual({
      event: 'integration.http_request',
      requestId: 'req-ctx-1',
      method: 'POST',
      route: '/api/v1/integration/documents/:documentId/signing-access',
      statusCode: 200,
      durationMs: expect.any(Number),
      outcome: 'success',
      apiKeyId: '0b3f7c2e-9a51-4f0e-8d2c-1e6b5a4c3d2f',
      organizationId: '7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6',
      documentId: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
      ip: '203.0.113.7',
      errorCode: null,
    });
  });

  it('usa lo anotado por el filtro y el controller', () => {
    const request = fakeRequest({ params: {} });
    annotateIntegrationAccess(request, {
      documentId: '9c8b7a6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      idempotencyReplayed: true,
    });
    const response = fakeResponse(200);
    run(request, response);
    response.emit('close');
    expect(events[0]).toEqual(
      expect.objectContaining({
        documentId: '9c8b7a6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
        idempotencyReplayed: true,
      }),
    );
  });

  it('un rechazo del guard: sin apiClient, con errorCode y errorType', () => {
    const request = fakeRequest({
      apiClient: undefined,
      clientIp: undefined,
      ip: '10.0.0.1',
    });
    annotateIntegrationAccess(request, {
      errorCode: 'API_KEY_INVALID',
      errorType: 'InvalidApiKeyException',
    });
    const response = fakeResponse(401);
    run(request, response);
    response.emit('close');
    expect(events[0]).toEqual(
      expect.objectContaining({
        statusCode: 401,
        outcome: 'client_error',
        apiKeyId: null,
        organizationId: null,
        ip: '10.0.0.1',
        errorCode: 'API_KEY_INVALID',
        errorType: 'InvalidApiKeyException',
      }),
    );
  });

  it('una conexión cortada queda como 499 client_closed', () => {
    const response = fakeResponse(200, false);
    run(fakeRequest(), response);
    response.emit('close');
    expect(events[0]).toEqual(
      expect.objectContaining({ statusCode: 499, outcome: 'client_closed' }),
    );
  });

  it('nunca registra headers sensibles, body ni nombre de la llave', () => {
    const response = fakeResponse(200);
    run(fakeRequest(), response);
    response.emit('close');
    expect(JSON.stringify(events[0])).not.toMatch(
      /fma_live_|EjemploNoReal|Bearer|session=|idem-secreta|ana@correo|"Ana"|Integración ERP/,
    );
  });

  it('ignora las rutas que no son de integración', () => {
    const response = fakeResponse(200);
    let continued = false;
    middleware.use(
      fakeRequest({ originalUrl: '/api/v1/documents' }),
      response,
      () => (continued = true),
    );
    response.emit('close');
    expect(continued).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('montado dos veces sobre la misma petición escribe un solo evento', () => {
    const request = fakeRequest();
    const response = fakeResponse(200);
    run(request, response);
    run(request, response);
    response.emit('close');
    expect(events).toHaveLength(1);
  });

  it('sin contexto usa el X-Request-Id ya escrito en la respuesta', () => {
    const response = fakeResponse(200);
    middleware.use(fakeRequest(), response, () => undefined);
    response.emit('close');
    expect(events[0].requestId).toBe('req-del-header');
  });

  it('un fallo del logger no sale del listener de close', () => {
    const throwing = new IntegrationAccessLogMiddleware(requestContext, {
      log: () => {
        throw new Error('boom');
      },
    } as unknown as IntegrationAccessLogger);
    const response = fakeResponse(200);
    throwing.use(fakeRequest(), response, () => undefined);
    expect(() => response.emit('close')).not.toThrow();
  });
});
