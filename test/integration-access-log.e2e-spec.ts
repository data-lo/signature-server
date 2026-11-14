import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { setTimeout as delay } from 'timers/promises';

import { InvalidApiKeyException } from './../src/api-key/exceptions/api-key.exceptions';
import { ApiKeyPermissionGuard } from './../src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from './../src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from './../src/api-key/interfaces/integration-api-client.interface';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { MulterExceptionFilter } from './../src/common/filters/multer-exception.filter';
import { RequestIpInterceptor } from './../src/common/interceptors/request-ip.interceptor';
import { CreateIntegrationDocumentUseCase } from './../src/document/integration/applications/create-integration-document.use-case';
import { IssueIntegrationSigningAccessUseCase } from './../src/document/integration/applications/issue-integration-signing-access.use-case';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import {
  INTEGRATION_VALIDATION_CODE_ENUM,
  IntegrationValidationException,
} from './../src/document/integration/validation/integration-validation.exception';
import { MetricsModule } from './../src/metrics/metrics.module';
import { MetricsService } from './../src/metrics/metrics.service';
import {
  applyIntegrationAccessLog,
  IntegrationAccessLogModule,
} from './../src/observability/integration-access-log/integration-access-log.module';
import { INTEGRATION_ACCESS_LOG_WRITER } from './../src/observability/integration-access-log/integration-access.logger';
import {
  applyRequestContext,
  RequestContextModule,
} from './../src/observability/request-context/request-context.module';
import { ACTION_KEY_ENUM } from './../src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './../src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './../src/roles/enums/resource-key.enum';
import { SigningRateLimitException } from './../src/signing-invitation/signing-rate-limit.service';

/**
 * Log de acceso `integration.http_request` de punta a punta, sobre Express real y sin base de
 * datos.
 *
 * La app se arma como `main.ts` y con TODO lo que también observa la petición, para comprobar que
 * no se duplica nada: `RequestIpInterceptor` global (además del declarado en las rutas),
 * `HttpMetricsMiddleware` y `MetricsExceptionFilter` con métricas activas, `MulterExceptionFilter`
 * global y el `ValidationPipe` global. Son reales `IntegrationDocumentsController`,
 * `IntegrationErrorFilter`, `FileInterceptor` y `ApiKeyPermissionGuard`; sólo se reemplazan
 * `OrganizationApiKeyGuard` (necesita Postgres) y los casos de uso.
 */

/** Llave válida del doble del guard; su `publicId` y su secreto no deben aparecer en ningún log. */
const VALID_KEY =
  'fma_live_a1b2c3d4e5f60718_SecretoDeLaLlaveValidaQueNoDebeLoguearse1';
const NO_PERMISSION_KEY =
  'fma_live_0f1e2d3c4b5a6978_SecretoDeLaLlaveSinPermisoQueNoDebeLoguear';
const INVALID_KEY =
  'fma_live_deadbeefdeadbeef_SecretoDeUnaLlaveInvalidaQueNoDebeVerse';
const IDEMPOTENCY_KEY = 'idem-clave-del-cliente-que-no-debe-loguearse';
const SIGNER_EMAIL = 'firmante.secreta@correo.test';
const SIGNER_NAME = 'Marisol Quintanilla';
const PDF = Buffer.from('%PDF-1.4\n%contenido-binario-del-contrato\n%%EOF');
const PAYLOAD = JSON.stringify({
  participants: [{ email: SIGNER_EMAIL, firstName: SIGNER_NAME }],
});

const API_CLIENT: IntegrationApiClient = {
  apiKeyId: randomUUID(),
  apiKeyName: 'Integración ERP Confidencial',
  organizationId: randomUUID(),
  actorAccountId: randomUUID(),
  actorUserId: randomUUID(),
  permissions: [
    {
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.CREATE,
      scope: PERMISSION_SCOPE_ENUM.ORGANIZATION,
    },
  ],
};

describe('Log de acceso de la API de integración (e2e)', () => {
  let app: INestApplication;
  /** Cada línea escrita por `IntegrationAccessLogger`, tal cual. */
  const lines: string[] = [];
  let createBehaviour: () => Promise<unknown>;
  let signingAccessBehaviour: () => Promise<unknown>;
  const createdDocumentId = randomUUID();

  /** Los eventos ya parseados. */
  const events = () => lines.map((line) => JSON.parse(line));

  /** Espera a que haya `count` líneas: el log se escribe en el `close`, tras la respuesta. */
  async function waitForLines(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && lines.length < count; attempt += 1) {
      await delay(10);
    }
    expect(lines).toHaveLength(count);
  }

  /** El único evento escrito tras la petición. */
  async function onlyEvent() {
    await waitForLines(1);
    // Margen para que una línea duplicada, si la hubiera, también llegue.
    await delay(20);
    expect(lines).toHaveLength(1);
    return events()[0];
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RequestContextModule,
        IntegrationAccessLogModule,
        MetricsModule.register({ enabled: true, path: '/metrics' }),
      ],
      controllers: [IntegrationDocumentsController],
      providers: [
        ApiKeyPermissionGuard,
        { provide: APP_INTERCEPTOR, useClass: RequestIpInterceptor },
        {
          provide: CreateIntegrationDocumentUseCase,
          useValue: { execute: () => createBehaviour() },
        },
        {
          provide: IssueIntegrationSigningAccessUseCase,
          useValue: { execute: () => signingAccessBehaviour() },
        },
      ],
    })
      .overrideProvider(INTEGRATION_ACCESS_LOG_WRITER)
      .useValue((line: string) => lines.push(line))
      .overrideGuard(OrganizationApiKeyGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const http = context.switchToHttp().getRequest();
          const key = http.headers['x-api-key'];
          if (key !== VALID_KEY && key !== NO_PERMISSION_KEY) {
            throw new InvalidApiKeyException();
          }
          http.apiClient =
            key === VALID_KEY ? API_CLIENT : { ...API_CLIENT, permissions: [] };
          return true;
        },
      })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication();
    applyRequestContext(app);
    applyIntegrationAccessLog(app);
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(
      new MulterExceptionFilter(app.get(HttpAdapterHost).httpAdapter),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    lines.length = 0;
    createBehaviour = async () => ({
      success: true,
      data: { id: createdDocumentId },
      replayed: false,
    });
    signingAccessBehaviour = async () => ({ success: true, data: {} });
  });

  function postDocument(headers: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/integration/documents')
      .set({
        'X-API-Key': VALID_KEY,
        'Idempotency-Key': IDEMPOTENCY_KEY,
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.no-debe-loguearse',
        Cookie: 'session=cookie-que-no-debe-loguearse',
        ...headers,
      })
      .field('payload', PAYLOAD)
      .attach('file', PDF, {
        filename: 'contrato-confidencial.pdf',
        contentType: 'application/pdf',
      });
  }

  describe('contenido del evento', () => {
    it('201: requestId del header, llave, organización, documento creado e IP', async () => {
      const response = await postDocument({
        'X-Request-Id': 'erp-alta-1',
      }).expect(201);
      const event = await onlyEvent();

      expect(response.headers['x-request-id']).toBe('erp-alta-1');
      expect(event).toEqual({
        timestamp: expect.any(String),
        level: 'info',
        event: 'integration.http_request',
        requestId: 'erp-alta-1',
        method: 'POST',
        route: '/api/v1/integration/documents',
        statusCode: 201,
        durationMs: expect.any(Number),
        outcome: 'success',
        apiKeyId: API_CLIENT.apiKeyId,
        organizationId: API_CLIENT.organizationId,
        documentId: createdDocumentId,
        ip: expect.any(String),
        errorCode: null,
        idempotencyReplayed: false,
      });
      expect(event.ip).not.toBeNull();
    });

    it('sin X-Request-Id, el evento lleva el UUID generado de la respuesta', async () => {
      const response = await postDocument().expect(201);
      const event = await onlyEvent();
      expect(event.requestId).toBe(response.headers['x-request-id']);
    });

    it('200 de una repetición idempotente: idempotencyReplayed true', async () => {
      createBehaviour = async () => ({
        success: true,
        data: { id: createdDocumentId },
        replayed: true,
      });
      await postDocument().expect(200);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          statusCode: 200,
          idempotencyReplayed: true,
          documentId: createdDocumentId,
        }),
      );
    });

    it('documentId sale del parámetro de la ruta', async () => {
      const documentId = randomUUID();
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${documentId}/signing-access`)
        .set('X-API-Key', VALID_KEY)
        .send({ email: SIGNER_EMAIL })
        .expect(200);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          route: '/api/v1/integration/documents/:documentId/signing-access',
          documentId,
          statusCode: 200,
        }),
      );
    });

    it('401: llave inválida, sin apiKeyId ni organización, con errorCode', async () => {
      const response = await postDocument({
        'X-API-Key': INVALID_KEY,
      }).expect(401);
      const event = await onlyEvent();
      expect(event).toEqual(
        expect.objectContaining({
          requestId: response.headers['x-request-id'],
          statusCode: 401,
          outcome: 'client_error',
          apiKeyId: null,
          organizationId: null,
          documentId: null,
          errorCode: 'API_KEY_INVALID',
          errorType: 'InvalidApiKeyException',
        }),
      );
      expect(event.ip).not.toBeNull();
      // Ni la llave, ni su publicId, ni un fragmento de su secreto.
      for (const fragment of [
        'fma_live',
        'deadbeefdeadbeef',
        'SecretoDeUna',
        'Invalida',
      ]) {
        expect(lines[0]).not.toContain(fragment);
      }
    });

    it('403: llave sin permiso, con su id y organización', async () => {
      await postDocument({ 'X-API-Key': NO_PERMISSION_KEY }).expect(403);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          statusCode: 403,
          apiKeyId: API_CLIENT.apiKeyId,
          organizationId: API_CLIENT.organizationId,
          errorCode: 'API_KEY_PERMISSION_DENIED',
        }),
      );
    });

    it('404: ruta inexistente bajo /integration queda como unmatched', async () => {
      await request(app.getHttpServer())
        .get(
          '/api/v1/integration/no-existe/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
        )
        .set('X-API-Key', VALID_KEY)
        .expect(404);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          route: 'unmatched',
          statusCode: 404,
          outcome: 'client_error',
          apiKeyId: null,
          documentId: null,
        }),
      );
    });

    it('404: documentId que no es UUID no se registra', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${SIGNER_EMAIL}/signing-access`)
        .set('X-API-Key', VALID_KEY)
        .send({ email: SIGNER_EMAIL })
        .expect(404);
      const event = await onlyEvent();
      expect(event.documentId).toBeNull();
      expect(lines[0]).not.toContain(SIGNER_EMAIL);
    });

    it('422: error de validación con su código', async () => {
      createBehaviour = async () => {
        throw new IntegrationValidationException(
          INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PAYLOAD,
          `El correo ${SIGNER_EMAIL} de ${SIGNER_NAME} no es válido`,
        );
      };
      await postDocument().expect(422);
      const event = await onlyEvent();
      expect(event).toEqual(
        expect.objectContaining({
          statusCode: 422,
          errorCode: 'INVALID_PAYLOAD',
          errorType: 'IntegrationValidationException',
        }),
      );
      expect(lines[0]).not.toMatch(/correo|Marisol|firmante/);
    });

    it('422: el 400 del ValidationPipe se registra como el 422 INVALID_REQUEST respondido', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${randomUUID()}/signing-access`)
        .set('X-API-Key', VALID_KEY)
        .send({ email: 'no-es-correo' })
        .expect(422);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          statusCode: 422,
          errorCode: 'INVALID_REQUEST',
        }),
      );
    });

    it('429: límite de frecuencia', async () => {
      createBehaviour = async () => {
        throw new SigningRateLimitException();
      };
      await postDocument().expect(429);
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          statusCode: 429,
          errorCode: 'TOO_MANY_REQUESTS',
          errorType: 'SigningRateLimitException',
        }),
      );
    });

    it('500: nivel error, INTERNAL_ERROR y la clase, sin mensaje ni stack', async () => {
      createBehaviour = async () => {
        throw new TypeError(`fallo de MinIO con ${SIGNER_EMAIL}`);
      };
      await postDocument().expect(500);
      const event = await onlyEvent();
      expect(event).toEqual(
        expect.objectContaining({
          level: 'error',
          statusCode: 500,
          outcome: 'server_error',
          errorCode: 'INTERNAL_ERROR',
          errorType: 'TypeError',
        }),
      );
      expect(lines[0]).not.toMatch(/MinIO|firmante|stack|at /);
    });

    it('400: JSON mal formado, rechazado antes del ruteo', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${randomUUID()}/signing-access`)
        .set({ 'X-API-Key': VALID_KEY, 'Content-Type': 'application/json' })
        .send(`{"email":"${SIGNER_EMAIL}"`)
        .expect(400);
      const event = await onlyEvent();
      expect(event.statusCode).toBe(400);
      expect(lines[0]).not.toContain(SIGNER_EMAIL);
    });

    it('conexión cortada por el cliente: 499 client_closed', async () => {
      createBehaviour = async () => {
        await delay(500);
        return {
          success: true,
          data: { id: createdDocumentId },
          replayed: false,
        };
      };
      await expect(postDocument().timeout(100)).rejects.toThrow();
      expect(await onlyEvent()).toEqual(
        expect.objectContaining({
          level: 'warn',
          statusCode: 499,
          outcome: 'client_closed',
          apiKeyId: API_CLIENT.apiKeyId,
        }),
      );
      // Que el caso de uso termine después no escribe otro evento.
      await delay(600);
      expect(lines).toHaveLength(1);
    });
  });

  describe('exactamente un evento por petición', () => {
    it('fuera de /api/v1/integration y en su documentación no se escribe nada', async () => {
      await request(app.getHttpServer()).get('/api/v1/documents').expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/integration-settings')
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/integration/docs-json')
        .expect(404);
      await delay(50);
      expect(lines).toHaveLength(0);
    });

    it('una mezcla concurrente de éxitos y errores escribe un evento por petición, con su requestId', async () => {
      const calls = Array.from({ length: 24 }, (_, index) => {
        const requestId = `req-mezcla-${index}`;
        const kind = index % 4;
        if (kind === 0) return postDocument({ 'X-Request-Id': requestId });
        if (kind === 1)
          return postDocument({
            'X-Request-Id': requestId,
            'X-API-Key': INVALID_KEY,
          });
        if (kind === 2)
          return postDocument({
            'X-Request-Id': requestId,
            'X-API-Key': NO_PERMISSION_KEY,
          });
        return request(app.getHttpServer())
          .get('/api/v1/integration/no-existe')
          .set('X-Request-Id', requestId);
      });
      const responses = await Promise.all(calls);
      await waitForLines(responses.length);
      await delay(30);
      expect(lines).toHaveLength(responses.length);

      const byRequestId = new Map(
        events().map((event) => [event.requestId, event]),
      );
      expect(byRequestId.size).toBe(responses.length);
      for (const response of responses) {
        const event = byRequestId.get(response.headers['x-request-id']);
        expect(event?.statusCode).toBe(response.status);
      }
    });
  });

  describe('no filtración', () => {
    it('ninguna línea lleva headers sensibles, PDF, body, correos ni nombres', async () => {
      await postDocument().expect(201);
      await postDocument({ 'X-API-Key': INVALID_KEY }).expect(401);
      createBehaviour = async () => {
        throw new Error(`${SIGNER_EMAIL} ${SIGNER_NAME} ${VALID_KEY}`);
      };
      await postDocument().expect(500);
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${randomUUID()}/signing-access`)
        .set('X-API-Key', VALID_KEY)
        .send({ email: SIGNER_EMAIL })
        .expect(200);
      await waitForLines(4);

      const all = lines.join('\n');
      for (const leaked of [
        'fma_live',
        'a1b2c3d4e5f60718',
        'SecretoDeLa',
        'deadbeefdeadbeef',
        'Bearer',
        'eyJhbGci',
        'session=',
        'cookie-que',
        IDEMPOTENCY_KEY,
        'idem-clave',
        '%PDF',
        'contenido-binario',
        'contrato-confidencial',
        'participants',
        SIGNER_EMAIL,
        'correo.test',
        SIGNER_NAME,
        'Marisol',
        API_CLIENT.apiKeyName,
        API_CLIENT.actorUserId!,
        API_CLIENT.actorAccountId!,
      ]) {
        expect({ leaked, found: all.includes(leaked) }).toEqual({
          leaked,
          found: false,
        });
      }
    });

    it('las métricas de Prometheus no llevan requestId, API key, organización ni documento', async () => {
      const documentId = randomUUID();
      await postDocument({ 'X-Request-Id': 'req-metricas-unico' }).expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${documentId}/signing-access`)
        .set('X-API-Key', VALID_KEY)
        .send({ email: SIGNER_EMAIL })
        .expect(200);
      await postDocument({ 'X-API-Key': INVALID_KEY }).expect(401);

      const metrics = await app.get(MetricsService).getMetrics();
      expect(metrics).toContain('/integration/documents');
      for (const value of [
        'req-metricas-unico',
        API_CLIENT.apiKeyId,
        API_CLIENT.organizationId,
        documentId,
        createdDocumentId,
        'API_KEY_INVALID',
      ]) {
        expect(metrics).not.toContain(value);
      }
    });
  });
});
