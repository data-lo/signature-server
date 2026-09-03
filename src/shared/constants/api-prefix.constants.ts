import type { INestApplication } from '@nestjs/common';

/**
 * Prefijo global de la API HTTP, aplicado una sola vez en el arranque (`applyGlobalApiPrefix`) en
 * vez de repetirse dentro de cada `@Controller()`.
 *
 * Mientras convivieron las dos formas —`@Controller('api/v1/users')` y `@Controller('user')`— la
 * misma API respondía en `/api/v1/...` y en `/...` según el módulo. Centralizarlo evita que el
 * próximo controlador vuelva a elegir, y evita el error inverso —dejar el `api/v1` local con el
 * prefijo global puesto— que produce rutas `/api/v1/api/v1/...`.
 */
export const GLOBAL_API_PREFIX = 'api/v1';

/**
 * Rutas que quedan FUERA del prefijo, con el motivo de cada una:
 *
 * - `health`: lo consumen probes de infraestructura que apuntan a una URL fija. El `HEALTHCHECK` del
 *   `Dockerfile` pide `http://localhost:4000/health` literalmente, y moverlo dejaría el contenedor
 *   marcado como `unhealthy`.
 * - `''` (la raíz): es el saludo de sanidad del andamiaje de Nest, excluido también del Swagger
 *   publicado. No es parte del contrato de la API.
 *
 * Ninguna devuelve datos de negocio: son los dos únicos endpoints fuera de la API pública.
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
