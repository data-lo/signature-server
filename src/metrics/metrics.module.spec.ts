import {
  ArgumentsHost,
  BadRequestException,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  INestApplication,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Response } from 'express';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from 'src/common/constants/api-prefix.constants';
import { MulterExceptionFilter } from 'src/common/filters/multer-exception.filter';

import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';

class RejectingGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('jwt inválido del usuario secreto');
  }
}

@Catch()
class OwnFormatFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(418).json({});
  }
}

@Controller('documents')
class DocumentsStub {
  @Get(':id')
  find(@Param('id') id: string) {
    if (id === 'missing') throw new NotFoundException('doc de ana@correo.mx');
    if (id === 'broken') throw new Error('fallo interno con datos sensibles');
    return { id };
  }

  @Post()
  @UseGuards(RejectingGuard)
  create() {
    return {};
  }
}

@Controller('integration')
@UseFilters(OwnFormatFilter)
class IntegrationStub {
  @Get('handler')
  handler() {
    throw new BadRequestException();
  }

  @Get('guard')
  @UseGuards(RejectingGuard)
  guard() {
    return {};
  }
}

@Controller('health')
class HealthStub {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

/**
 * Levanta la instrumentación completa sobre rutas de mentira y con la misma cadena de producción
 * (prefijo global + `MulterExceptionFilter`), sin Postgres, Mongo, Redis ni Kafka. Las reglas de
 * precedencia entre guards, interceptores y filtros que motivan el diseño sólo se ven así.
 */
describe('MetricsModule', () => {
  describe('activo', () => {
    let app: INestApplication;
    let metrics: MetricsService;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MetricsModule.register({ enabled: true, path: '/metrics' })],
        controllers: [DocumentsStub, IntegrationStub, HealthStub],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      applyGlobalApiPrefix(app);
      const { httpAdapter } = app.get(HttpAdapterHost);
      app.useGlobalFilters(new MulterExceptionFilter(httpAdapter));
      await app.init();
      metrics = app.get(MetricsService);
    });

    afterAll(async () => {
      await app.close();
    });

    /**
     * Lee el valor de una serie. Reintenta porque la medición se registra en el `close` de la
     * respuesta, que puede disparar justo después de que el cliente ya la recibió.
     */
    const seriesValue = async (series: string): Promise<number> => {
      let value = 0;
      for (let attempt = 0; attempt < 20 && value === 0; attempt += 1) {
        const body = await metrics.getMetrics();
        const line = body
          .split('\n')
          .find((candidate) => candidate.startsWith(`${series} `));
        value = line ? Number(line.split(' ').pop()) : 0;
        if (value === 0) await new Promise((r) => setTimeout(r, 10));
      }
      return value;
    };

    it('GET /metrics responde 200 sin prefijo y con el Content-Type de Prometheus', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics')
        .expect(200);

      // Express reordena los parámetros al escribirlo; para Prometheus es el mismo tipo.
      expect(response.headers['content-type']).toBe(
        'text/plain; charset=utf-8; version=0.0.4',
      );
      expect(response.text).toContain(
        '# TYPE http_server_requests_total counter',
      );
      expect(response.text).toContain('process_cpu_seconds_total');
      expect(response.text).toContain('nodejs_eventloop_lag_seconds');
      expect(response.text).toContain('nodejs_heap_size_used_bytes');
    });

    it('cuenta y mide una petición exitosa una sola vez, con la plantilla de la ruta', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/documents/abc-123')
        .expect(200);

      const labels =
        'method="GET",route="/api/v1/documents/:id",status_code="200"';
      expect(await seriesValue(`http_server_requests_total{${labels}}`)).toBe(
        1,
      );
      expect(
        await seriesValue(
          `http_server_request_duration_seconds_count{${labels}}`,
        ),
      ).toBe(1);
      expect(await metrics.getMetrics()).not.toContain('abc-123');
    });

    it('un 4xx lanzado por el handler cuenta como error con la clase de la excepción', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/documents/missing')
        .expect(404);

      expect(
        await seriesValue(
          'http_server_errors_total{route="/api/v1/documents/:id",status_code="404",error_type="NotFoundException"}',
        ),
      ).toBe(1);
    });

    it('un 5xx conserva la respuesta por defecto de Nest y no filtra el mensaje', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/documents/broken')
        .expect(500);

      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(
        await seriesValue(
          'http_server_errors_total{route="/api/v1/documents/:id",status_code="500",error_type="Error"}',
        ),
      ).toBe(1);
      expect(await metrics.getMetrics()).not.toContain('datos sensibles');
    });

    it('un rechazo de guard cuenta aunque nunca llegue al interceptor', async () => {
      await request(app.getHttpServer()).post('/api/v1/documents').expect(401);

      const labels = 'route="/api/v1/documents",status_code="401"';
      expect(
        await seriesValue(
          `http_server_requests_total{method="POST",${labels}}`,
        ),
      ).toBe(1);
      expect(
        await seriesValue(
          `http_server_errors_total{${labels},error_type="UnauthorizedException"}`,
        ),
      ).toBe(1);
    });

    it('un filtro de controlador no esconde el error y se registra su estado final', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/handler')
        .expect(418);

      expect(
        await seriesValue(
          'http_server_errors_total{route="/api/v1/integration/handler",status_code="418",error_type="BadRequestException"}',
        ),
      ).toBe(1);
    });

    it('un rechazo de guard atrapado por un filtro de controlador cuenta sin clase', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/guard')
        .expect(418);

      expect(
        await seriesValue(
          'http_server_errors_total{route="/api/v1/integration/guard",status_code="418",error_type="UnknownError"}',
        ),
      ).toBe(1);
    });

    it.each(['/api/v1/no-existe/usr_123', '/no-existe/usr_123'])(
      'una ruta inexistente (%s) va a "unmatched", sin la URL real',
      async (url) => {
        await request(app.getHttpServer()).get(url).expect(404);

        expect(
          await seriesValue(
            'http_server_requests_total{method="GET",route="unmatched",status_code="404"}',
          ),
        ).toBeGreaterThanOrEqual(1);
        expect(await metrics.getMetrics()).not.toContain('usr_123');
      },
    );

    it('/health y /metrics no aparecen en las métricas HTTP', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/metrics').expect(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const body = await metrics.getMetrics();
      expect(body).not.toContain('route="/health"');
      expect(body).not.toContain('route="/metrics"');
    });

    it('el gauge de peticiones en curso vuelve a cero al terminar', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/documents/abc-123')
        .expect(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await metrics.getMetrics()).toContain(
        'http_server_in_flight_requests{method="GET",route="/api/v1/documents/:id"} 0',
      );
    });
  });

  describe('con METRICS_PATH propio', () => {
    it('expone el endpoint en esa ruta', async () => {
      process.env.METRICS_PATH = '/internal/metrics';
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [
            MetricsModule.register({
              enabled: true,
              path: '/internal/metrics',
            }),
          ],
        }).compile();
        const app = moduleRef.createNestApplication({ logger: false });
        applyGlobalApiPrefix(app);
        await app.init();

        await request(app.getHttpServer()).get('/internal/metrics').expect(200);
        await request(app.getHttpServer()).get('/metrics').expect(404);

        await app.close();
      } finally {
        delete process.env.METRICS_PATH;
      }
    });
  });

  describe('apagado', () => {
    it('no expone el endpoint, no instrumenta y deja disponible MetricsService', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MetricsModule.register({ enabled: false, path: '/metrics' })],
        controllers: [DocumentsStub],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      applyGlobalApiPrefix(app);
      await app.init();

      await request(app.getHttpServer()).get('/metrics').expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/documents/abc-123')
        .expect(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const body = await app.get(MetricsService).getMetrics();
      expect(body).not.toContain('route="/api/v1/documents/:id"');
      expect(body).not.toContain('process_cpu_seconds_total');

      await app.close();
    });
  });
});
