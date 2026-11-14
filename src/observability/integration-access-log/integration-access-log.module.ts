import { INestApplication, Module } from '@nestjs/common';

import { IntegrationAccessLogMiddleware } from './integration-access-log.middleware';
import {
  INTEGRATION_ACCESS_LOG_WRITER,
  IntegrationAccessLogger,
  stdoutIntegrationAccessLogWriter,
} from './integration-access.logger';

/**
 * Log de acceso de la API de integración (`integration.http_request`). Depende de
 * `RequestContextModule`, que es global.
 *
 * Como el contexto de petición, el middleware no se registra con `configure(consumer)`: tiene que
 * correr antes que los parsers de body y que el ruteo para ver también lo que éstos rechazan. Lo
 * monta `applyIntegrationAccessLog` en `main.ts`.
 */
@Module({
  providers: [
    // Registrado aunque sea el valor por defecto, para que las pruebas lo reemplacen con
    // `overrideProvider(INTEGRATION_ACCESS_LOG_WRITER)`.
    {
      provide: INTEGRATION_ACCESS_LOG_WRITER,
      useValue: stdoutIntegrationAccessLogWriter,
    },
    IntegrationAccessLogger,
    IntegrationAccessLogMiddleware,
  ],
  exports: [IntegrationAccessLogger],
})
export class IntegrationAccessLogModule {}

/**
 * Monta `IntegrationAccessLogMiddleware` como middleware de Express de la app.
 *
 * Va inmediatamente después de `applyRequestContext`, para que el `requestId` ya exista, y antes
 * de `app.init()`/`app.listen()`, cuando Nest registra sus parsers y sus rutas.
 *
 * @param app - App de Nest con `IntegrationAccessLogModule` y `RequestContextModule` importados.
 * @returns Nada.
 *
 * @throws {Error} Si la app no importa `IntegrationAccessLogModule`.
 *
 * @example
 * ```ts
 * applyRequestContext(app);
 * applyIntegrationAccessLog(app);
 * ```
 */
export function applyIntegrationAccessLog(app: INestApplication): void {
  const middleware = app.get(IntegrationAccessLogMiddleware);
  app.use(middleware.use.bind(middleware));
}
