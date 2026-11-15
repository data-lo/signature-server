import { Global, INestApplication, Module } from '@nestjs/common';

import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

/**
 * Contexto de correlación de las peticiones HTTP. Es global para que cualquier servicio inyecte
 * `RequestContextService` sin importar el módulo.
 *
 * El middleware NO se registra con `configure(consumer)`: los middleware de módulo corren después
 * de los parsers de body y en el orden de los módulos, y el contexto tiene que abrirse antes que
 * todo. Lo monta `applyRequestContext` en `main.ts`.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule {}

/**
 * Monta `RequestContextMiddleware` como primer middleware de Express de la app.
 *
 * Es una función compartida —como `applyGlobalApiPrefix`— para que las pruebas e2e, que no pasan
 * por `bootstrap()`, monten el contexto igual que producción. Hay que llamarla antes de
 * `app.init()`/`app.listen()`, que es cuando Nest registra sus parsers de body y sus rutas.
 *
 * @param app - App de Nest con `RequestContextModule` importado.
 * @returns Nada.
 *
 * @throws {Error} Si la app no importa `RequestContextModule` (Nest no encuentra el servicio).
 *
 * @example
 * ```ts
 * const app = await NestFactory.create(AppModule);
 * applyRequestContext(app);
 * ```
 */
export function applyRequestContext(app: INestApplication): void {
  const middleware = new RequestContextMiddleware(
    app.get(RequestContextService),
  );
  app.use(middleware.use.bind(middleware));
}
