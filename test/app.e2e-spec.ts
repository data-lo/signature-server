import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { applyGlobalApiPrefix } from './../src/shared/constants/api-prefix.constants';

/**
 * Levantar el `AppModule` COMPLETO tarda bastante más que el timeout de 5 s que trae jest por
 * defecto: abre la conexión a Postgres, la de Mongo, la de Redis y el cliente de Kafka. No es
 * lentitud a corregir, es lo que cuesta arrancar la aplicación de verdad — y arrancarla de
 * verdad es justamente el sentido de esta prueba, que comprueba el ruteo real y no uno armado
 * a mano con un puñado de controladores.
 */
const APP_BOOT_TIMEOUT_MS = 60_000;

describe('AppController (e2e)', () => {
  let app: INestApplication;

  /**
   * `beforeAll` y no `beforeEach`: el arranque es caro y ninguna de estas pruebas muta estado,
   * así que repetirlo por cada una sólo multiplicaba el costo (y dejaba una app sin cerrar por
   * cada `it`, que es de donde salía el aviso de jest sobre procesos que no terminan).
   */
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mismo prefijo global que monta main.ts, para que la prueba confirme lo que de verdad
    // importa acá: que `GET /` está EXCLUIDO del prefijo y sigue contestando en la raíz.
    applyGlobalApiPrefix(app);
    await app.init();
  }, APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  /**
   * La otra exclusión de `GLOBAL_API_PREFIX_EXCLUDE`. Se afirma el 404 bajo el prefijo y no el
   * 200 en `/health` a propósito: el healthcheck real hace ping a Postgres, Mongo y Redis, así
   * que su código de estado depende de que la infraestructura local esté levantada — lo que se
   * quiere fijar acá es que la ruta NO se movió bajo `/api/v1`, que es lo que dejaría el
   * `HEALTHCHECK` del Dockerfile apuntando a una URL inexistente y el contenedor `unhealthy`.
   */
  it('/health queda fuera del prefijo global', () => {
    return request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
