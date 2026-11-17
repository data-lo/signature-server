import {
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  NestInterceptor,
  Post,
  Body,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
  Query,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsString } from 'class-validator';
import { randomUUID } from 'crypto';
import { from, mergeMap, Observable } from 'rxjs';
import * as request from 'supertest';
import { setTimeout as delay } from 'timers/promises';

import { ApiKeyPermissionGuard } from './../src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from './../src/api-key/guards/organization-api-key.guard';
import { InvalidApiKeyException } from './../src/api-key/exceptions/api-key.exceptions';
import { IntegrationApiClient } from './../src/api-key/interfaces/integration-api-client.interface';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { CreateIntegrationDocumentUseCase } from './../src/document/integration/applications/create-integration-document.use-case';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import {
  INTEGRATION_VALIDATION_CODE_ENUM,
  IntegrationValidationException,
} from './../src/document/integration/validation/integration-validation.exception';
import { MetricsModule } from './../src/metrics/metrics.module';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
} from './../src/observability/request-context/request-context.constants';
import { RequestContext } from './../src/observability/request-context/request-context.interface';
import {
  applyRequestContext,
  RequestContextModule,
} from './../src/observability/request-context/request-context.module';
import { RequestContextService } from './../src/observability/request-context/request-context.service';
import { ACTION_KEY_ENUM } from './../src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './../src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './../src/roles/enums/resource-key.enum';
import { SigningRateLimitException } from './../src/signing-invitation/signing-rate-limit.service';

/**
 * `X-Request-Id` y el contexto de correlación de punta a punta, sobre Express real.
 *
 * La app se arma como `main.ts`: `applyRequestContext` antes que `applyGlobalApiPrefix`, el
 * `ValidationPipe` global y `app.init()` al final. No toca ninguna base de datos.
 *
 * - **Sondeo**: un guard, un interceptor, un controller y un servicio que anotan el `requestId`
 *   que ven, para comprobar que es el mismo en todas las capas, que no se mezcla entre peticiones
 *   concurrentes y que el header sale en 400 (pipe global y parser de JSON), 401, 403, 429
 *   (`ThrottlerGuard` real), 404 y 500.
 * - **Integración**: el `IntegrationDocumentsController` real con `IntegrationErrorFilter`,
 *   `FileInterceptor` (multipart con PDF), `RequestIpInterceptor` y `ApiKeyPermissionGuard`
 *   reales. Sólo se reemplazan `OrganizationApiKeyGuard` (que necesita Postgres) y el caso de uso.
 *   Cubre 201, 401, 403, 422 (con la forma de error de integración), 429 y 500.
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lo que cada capa vio de la petición, guardado aparte (no en el `Request`). */
const seenByLayer = new Map<string, Record<string, string | undefined>>();

/** Anota lo que vio una capa bajo la clave de sondeo de la petición. */
function note(probeKey: string, layer: string, requestId?: string): void {
  seenByLayer.set(probeKey, {
    ...seenByLayer.get(probeKey),
    [layer]: requestId,
  });
}

/** Clave de sondeo de una petición (header `x-probe-key`), independiente de `X-Request-Id`. */
function probeKeyOf(context: ExecutionContext): string {
  return context.switchToHttp().getRequest().headers['x-probe-key'] ?? '';
}

@Injectable()
class ProbeService {
  constructor(private readonly requestContext: RequestContextService) {}

  /** Espera y lee el contexto: prueba que sobrevive a un `await` dentro de un servicio. */
  async read(waitMs: number): Promise<RequestContext | undefined> {
    await delay(waitMs);
    return this.requestContext.get();
  }
}

@Injectable()
class ProbeGuard implements CanActivate {
  constructor(private readonly requestContext: RequestContextService) {}

  canActivate(context: ExecutionContext): boolean {
    note(probeKeyOf(context), 'guard', this.requestContext.getRequestId());
    const auth = context.switchToHttp().getRequest().headers['x-probe-auth'];
    if (auth === 'missing') throw new UnauthorizedException();
    if (auth === 'denied') throw new ForbiddenException();
    return true;
  }
}

@Injectable()
class ProbeInterceptor implements NestInterceptor {
  constructor(private readonly requestContext: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const key = probeKeyOf(context);
    note(key, 'interceptorBefore', this.requestContext.getRequestId());
    return next.handle().pipe(
      mergeMap((value) =>
        from(
          delay(1).then(() => {
            note(key, 'interceptorAfter', this.requestContext.getRequestId());
            return value;
          }),
        ),
      ),
    );
  }
}

class ProbeBodyDto {
  @IsString()
  name!: string;
}

@UseGuards(ProbeGuard)
@UseInterceptors(ProbeInterceptor)
@Controller('probe')
class ProbeController {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly probe: ProbeService,
  ) {}

  @Get('ids')
  async ids(@Query('wait') wait = '0', @Query('key') key = '') {
    const controller = this.requestContext.getRequestId();
    const context = await this.probe.read(Number(wait));
    return { key, controller, service: context?.requestId, context };
  }

  @Post('validate')
  validate(@Body() body: ProbeBodyDto) {
    return body;
  }

  @Get('throttled')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  throttled() {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('fallo interno de prueba');
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 100 }] }),
  ],
  controllers: [ProbeController],
  providers: [ProbeService, ProbeGuard, ProbeInterceptor],
})
class ProbeModule {}

/** API key "válida" del doble de `OrganizationApiKeyGuard`. */
const VALID_KEY =
  'fma_live_0123456789abcdef_EjemploNoRealEjemploNoRealEjemploNoRea';
/** API key que autentica pero sin `DOCUMENT.CREATE`: 403 del `ApiKeyPermissionGuard` real. */
const NO_PERMISSION_KEY =
  'fma_live_fedcba9876543210_EjemploNoRealEjemploNoRealEjemploNoRea';

const API_CLIENT: IntegrationApiClient = {
  apiKeyId: randomUUID(),
  apiKeyName: 'Integración ERP',
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

/** Un PDF mínimo: el caso de uso es un doble, sólo importa que viaje como multipart. */
const PDF = Buffer.from('%PDF-1.4\n%datos-del-pdf-de-prueba\n%%EOF');
const PAYLOAD = JSON.stringify({
  participants: [{ email: 'ana@correo.test', firstName: 'Ana' }],
});

describe('Contexto de petición y X-Request-Id (e2e)', () => {
  let app: INestApplication;
  let requestContext: RequestContextService;
  /** Comportamiento del doble del caso de uso en la prueba en curso. */
  let createBehaviour: () => Promise<unknown>;
  /** Contextos vistos por el caso de uso, en orden. */
  const seenByUseCase: (RequestContext | undefined)[] = [];
  /** `requestId` visto por el doble del guard de API key. */
  const seenByApiKeyGuard: (string | undefined)[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RequestContextModule,
        ProbeModule,
        MetricsModule.register({ enabled: false, path: '/metrics' }),
      ],
      controllers: [IntegrationDocumentsController],
      providers: [
        ApiKeyPermissionGuard,
        {
          provide: CreateIntegrationDocumentUseCase,
          useValue: {
            execute: async () => {
              seenByUseCase.push(requestContext.get());
              return createBehaviour();
            },
          },
        },
      ],
    })
      .overrideGuard(OrganizationApiKeyGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          seenByApiKeyGuard.push(requestContext.getRequestId());
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
    // Mismo orden que `main.ts`.
    applyRequestContext(app);
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    requestContext = app.get(RequestContextService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    seenByUseCase.length = 0;
    seenByApiKeyGuard.length = 0;
    createBehaviour = async () => ({
      replayed: false,
      data: { documentId: randomUUID() },
    });
  });

  describe('POST /api/v1/integration/documents', () => {
    function postDocument(headers: Record<string, string> = {}) {
      return request(app.getHttpServer())
        .post('/api/v1/integration/documents')
        .set({
          'X-API-Key': VALID_KEY,
          'Idempotency-Key': randomUUID(),
          ...headers,
        })
        .field('payload', PAYLOAD)
        .attach('file', PDF, {
          filename: 'contrato.pdf',
          contentType: 'application/pdf',
        });
    }

    it('201: devuelve un X-Request-Id generado si no se manda', async () => {
      const response = await postDocument().expect(201);
      expect(response.headers['x-request-id']).toMatch(UUID_V4);
    });

    it('201: devuelve el mismo X-Request-Id si es válido', async () => {
      const response = await postDocument({
        [REQUEST_ID_HEADER]: 'erp-20261114-7f3c2a9d',
      }).expect(201);
      expect(response.headers['x-request-id']).toBe('erp-20261114-7f3c2a9d');
    });

    it.each([
      ['inválido', 'req con espacios'],
      ['demasiado largo', 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1)],
    ])('201: genera uno nuevo si el recibido es %s', async (_, value) => {
      const response = await postDocument({
        [REQUEST_ID_HEADER]: value,
      }).expect(201);
      expect(response.headers['x-request-id']).toMatch(UUID_V4);
      expect(response.headers['x-request-id']).not.toBe(value);
    });

    it('el guard de API key y el caso de uso (después de multer) ven el mismo requestId', async () => {
      await postDocument({ [REQUEST_ID_HEADER]: 'req-capas-1' }).expect(201);
      expect(seenByApiKeyGuard).toEqual(['req-capas-1']);
      expect(seenByUseCase.map((context) => context?.requestId)).toEqual([
        'req-capas-1',
      ]);
    });

    it('el contexto no lleva API key, payload, PDF ni datos personales', async () => {
      await postDocument({ [REQUEST_ID_HEADER]: 'req-limpio-1' }).expect(201);
      const [context] = seenByUseCase;
      expect(context).toEqual({
        requestId: 'req-limpio-1',
        method: 'POST',
        path: '/api/v1/integration/documents',
        startedAt: expect.any(String),
      });
      const json = JSON.stringify(context);
      for (const leaked of [
        VALID_KEY,
        'fma_live_',
        'ana@correo.test',
        'participants',
        '%PDF',
        'contrato.pdf',
      ]) {
        expect(json).not.toContain(leaked);
      }
    });

    it('401: API key inválida', async () => {
      const response = await postDocument({
        'X-API-Key': 'no-es-una-llave',
        [REQUEST_ID_HEADER]: 'req-401',
      }).expect(401);
      expect(response.headers['x-request-id']).toBe('req-401');
      expect(response.body.success).toBe(false);
    });

    it('403: la llave no tiene DOCUMENT.CREATE', async () => {
      const response = await postDocument({
        'X-API-Key': NO_PERMISSION_KEY,
        [REQUEST_ID_HEADER]: 'req-403',
      }).expect(403);
      expect(response.headers['x-request-id']).toBe('req-403');
    });

    it('422: payload rechazado por la validación de integración', async () => {
      createBehaviour = async () => {
        throw new IntegrationValidationException(
          INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PAYLOAD,
          'payload inválido',
        );
      };
      const response = await postDocument({
        [REQUEST_ID_HEADER]: 'req-422',
      }).expect(422);
      expect(response.headers['x-request-id']).toBe('req-422');
      expect(response.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('429: límite de frecuencia', async () => {
      createBehaviour = async () => {
        throw new SigningRateLimitException();
      };
      const response = await postDocument({
        [REQUEST_ID_HEADER]: 'req-429',
      }).expect(429);
      expect(response.headers['x-request-id']).toBe('req-429');
    });

    it('500: error inesperado', async () => {
      createBehaviour = async () => {
        throw new Error('fallo de MinIO');
      };
      const response = await postDocument({
        [REQUEST_ID_HEADER]: 'req-500',
      }).expect(500);
      expect(response.headers['x-request-id']).toBe('req-500');
      expect(JSON.stringify(response.body)).not.toContain('MinIO');
    });

    it('peticiones multipart concurrentes no comparten contexto', async () => {
      createBehaviour = async () => {
        const before = requestContext.getRequestId();
        await delay(Math.floor(Math.random() * 20));
        return {
          replayed: false,
          data: { before, after: requestContext.getRequestId() },
        };
      };
      const ids = Array.from(
        { length: 15 },
        (_, index) => `req-multi-${index}`,
      );
      const responses = await Promise.all(
        ids.map((id) => postDocument({ [REQUEST_ID_HEADER]: id })),
      );
      responses.forEach((response, index) => {
        expect(response.status).toBe(201);
        expect(response.headers['x-request-id']).toBe(ids[index]);
        expect(response.body.data).toEqual({
          before: ids[index],
          after: ids[index],
        });
      });
    });
  });

  describe('sondeo de capas', () => {
    it('guard, interceptor (antes y después), controller y servicio ven el mismo requestId', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/ids?wait=5&key=capas')
        .set({ [REQUEST_ID_HEADER]: 'req-sondeo-1', 'x-probe-key': 'capas' })
        .expect(200);

      expect(response.headers['x-request-id']).toBe('req-sondeo-1');
      expect(response.body.controller).toBe('req-sondeo-1');
      expect(response.body.service).toBe('req-sondeo-1');
      expect(seenByLayer.get('capas')).toEqual({
        guard: 'req-sondeo-1',
        interceptorBefore: 'req-sondeo-1',
        interceptorAfter: 'req-sondeo-1',
      });
      expect(response.body.context).toEqual({
        requestId: 'req-sondeo-1',
        method: 'GET',
        path: '/api/v1/probe/ids',
        startedAt: expect.stringMatching(/Z$/),
      });
    });

    it('cincuenta peticiones concurrentes no comparten contexto', async () => {
      const keys = Array.from(
        { length: 50 },
        (_, index) => `concurrente-${index}`,
      );
      const responses = await Promise.all(
        keys.map((key, index) =>
          request(app.getHttpServer())
            .get(`/api/v1/probe/ids?wait=${(index * 7) % 23}&key=${key}`)
            .set({ [REQUEST_ID_HEADER]: `req-${key}`, 'x-probe-key': key }),
        ),
      );
      responses.forEach((response, index) => {
        const expected = `req-${keys[index]}`;
        expect(response.status).toBe(200);
        expect(response.headers['x-request-id']).toBe(expected);
        expect(response.body.controller).toBe(expected);
        expect(response.body.service).toBe(expected);
        expect(seenByLayer.get(keys[index])).toEqual({
          guard: expected,
          interceptorBefore: expected,
          interceptorAfter: expected,
        });
      });
    });

    it('sin header, cada petición recibe un UUID distinto', async () => {
      const [first, second] = await Promise.all([
        request(app.getHttpServer()).get('/api/v1/probe/ids').expect(200),
        request(app.getHttpServer()).get('/api/v1/probe/ids').expect(200),
      ]);
      expect(first.headers['x-request-id']).toMatch(UUID_V4);
      expect(second.headers['x-request-id']).toMatch(UUID_V4);
      expect(first.headers['x-request-id']).not.toBe(
        second.headers['x-request-id'],
      );
      expect(first.body.controller).toBe(first.headers['x-request-id']);
    });

    it('ignora traceparent y otros headers de correlación', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/ids')
        .set({
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          'X-Correlation-Id': 'corr-1',
        })
        .expect(200);
      expect(response.headers['x-request-id']).toMatch(UUID_V4);
      expect(response.headers).not.toHaveProperty('traceparent');
      expect(response.headers).not.toHaveProperty('x-correlation-id');
      expect(JSON.stringify(response.body.context)).not.toMatch(
        /4bf92f3577b34da6|corr-1/,
      );
    });

    it.each([
      ['401', 'missing', 401],
      ['403', 'denied', 403],
    ])('%s de un guard lleva X-Request-Id', async (_, auth, status) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/ids')
        .set({
          [REQUEST_ID_HEADER]: `req-guard-${status}`,
          'x-probe-auth': auth,
        })
        .expect(status);
      expect(response.headers['x-request-id']).toBe(`req-guard-${status}`);
    });

    it('400 del ValidationPipe global lleva X-Request-Id', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .set(REQUEST_ID_HEADER, 'req-pipe-400')
        .send({ name: 42 })
        .expect(400);
      expect(response.headers['x-request-id']).toBe('req-pipe-400');
    });

    it('400 de un JSON mal formado (parser de body) lleva X-Request-Id', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .set({
          [REQUEST_ID_HEADER]: 'req-json-400',
          'Content-Type': 'application/json',
        })
        .send('{"name":')
        .expect(400);
      expect(response.headers['x-request-id']).toBe('req-json-400');
    });

    it('429 del ThrottlerGuard lleva X-Request-Id', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/probe/throttled')
        .expect(200);
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/throttled')
        .set(REQUEST_ID_HEADER, 'req-throttle-429')
        .expect(429);
      expect(response.headers['x-request-id']).toBe('req-throttle-429');
    });

    it('500 de un error no controlado lleva X-Request-Id', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/boom')
        .set(REQUEST_ID_HEADER, 'req-boom-500')
        .expect(500);
      expect(response.headers['x-request-id']).toBe('req-boom-500');
    });

    it('404 de una ruta inexistente lleva X-Request-Id', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/no-existe')
        .set(REQUEST_ID_HEADER, 'req-404')
        .expect(404);
      expect(response.headers['x-request-id']).toBe('req-404');
    });

    it('fuera de una petición no queda contexto', async () => {
      await request(app.getHttpServer()).get('/api/v1/probe/ids').expect(200);
      expect(requestContext.get()).toBeUndefined();
    });
  });
});
