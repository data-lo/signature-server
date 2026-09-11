import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './api-prefix.constants';

/**
 * Controladores de mentira que reproducen las CUATRO formas que existen en el proyecto, para
 * verificar el ruteo real —no la constante— sin levantar Postgres, Mongo, Redis ni Kafka:
 *
 * 1. Un recurso con subruta (`webhooks` + `@Post('stripe')`), la forma que más importa: son los
 *    endpoints que invocan Stripe y Didit con una URL ya registrada del lado de ellos.
 * 2. Un endpoint heredado sin versión propia (`auth`), de los que antes vivían en la raíz.
 * 3. `health`, excluido del prefijo.
 * 4. La raíz `@Controller()`, también excluida.
 */
@Controller('webhooks')
class WebhooksStub {
  @Post('stripe')
  stripe() {
    return { ok: 'stripe' };
  }

  @Post('didit')
  didit() {
    return { ok: 'didit' };
  }
}

@Controller('auth')
class AuthStub {
  @Post('login')
  login() {
    return { ok: 'login' };
  }
}

@Controller('health')
class HealthStub {
  @Get()
  check() {
    return { ok: 'health' };
  }
}

@Controller()
class RootStub {
  @Get()
  hello() {
    return { ok: 'root' };
  }
}

describe('prefijo global de la API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksStub, AuthStub, HealthStub, RootStub],
    }).compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('rutas prefijadas', () => {
    it('los webhooks de Stripe y Didit siguen respondiendo en /api/v1/webhooks/*', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/didit')
        .expect(201);
    });

    it('un endpoint heredado que antes vivía en la raíz ahora cuelga del prefijo', async () => {
      await request(app.getHttpServer()).post('/api/v1/auth/login').expect(201);
    });

    it('la ruta sin prefijo ya no existe: el consumidor tiene que actualizarse, no quedarse a medias', async () => {
      await request(app.getHttpServer()).post('/webhooks/stripe').expect(404);
      await request(app.getHttpServer()).post('/auth/login').expect(404);
    });

    /**
     * La regresión que motiva centralizar el prefijo: si un controlador conserva su `api/v1`
     * local mientras el prefijo global está puesto, su ruta real pasa a ser
     * `/api/v1/api/v1/...` y el endpoint desaparece de donde lo busca el cliente.
     */
    it('no se duplica el prefijo', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/api/v1/webhooks/stripe')
        .expect(404);
    });
  });

  describe('exclusiones', () => {
    it('/health queda en la raíz: es la URL fija que pide el HEALTHCHECK del Dockerfile', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/api/v1/health').expect(404);
    });

    it('GET / queda en la raíz: es el saludo de sanidad, no parte del contrato de la API', async () => {
      await request(app.getHttpServer()).get('/').expect(200);
      await request(app.getHttpServer()).get('/api/v1').expect(404);
    });
  });
});
