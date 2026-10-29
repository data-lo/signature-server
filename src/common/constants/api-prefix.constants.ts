import type { INestApplication } from '@nestjs/common';

/**
 * Prefijo global de la API HTTP. Se aplica una sola vez en el arranque
 * (`applyGlobalApiPrefix`) en vez de repetirse dentro de cada `@Controller()`.
 *
 */
export const GLOBAL_API_PREFIX = 'api/v1';

/**
 * Rutas que quedan FUERA del prefijo, con el motivo por el que cada una se queda donde está:
 *
 * - `health`: lo consumen probes de infraestructura que apuntan a una URL fija y no pasan por
 *   el versionado de la API. El `HEALTHCHECK` del `Dockerfile` pide `http://localhost:4000/health`
 *   literalmente; moverlo a `/api/v1/health` dejaría el contenedor marcado como `unhealthy`.
 * - `''` (la raíz): `GET /` es el saludo de sanidad del andamiaje de Nest, excluido también del
 *   Swagger publicado (ver `ApiGetHello`). No es parte del contrato de la API, así que no le
 *   corresponde vivir bajo el prefijo versionado.
 *
 * Ninguna de las dos devuelve datos de negocio: son los dos únicos endpoints que no forman
 * parte de la API pública. Todo lo demás va prefijado.
 */
export const GLOBAL_API_PREFIX_EXCLUDE = ['health', '/'];

/**
 * Aplica el prefijo global a una app de Nest.
 *
 * Existe como función compartida —y no como un `setGlobalPrefix` suelto en `main.ts`— para que
 * las pruebas e2e, que construyen la app con `createNestApplication()` y no pasan por
 * `bootstrap()`, monten exactamente el mismo ruteo que producción. Si la lista de exclusiones
 * cambia, cambia en un solo lugar y las pruebas siguen probando las rutas reales.
 */
export function applyGlobalApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_API_PREFIX, {
    exclude: GLOBAL_API_PREFIX_EXCLUDE,
  });
}
