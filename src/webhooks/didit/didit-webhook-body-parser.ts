import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'http';

import { GLOBAL_API_PREFIX } from 'src/common/constants/api-prefix.constants';

const DIDIT_WEBHOOK_PATH = `/${GLOBAL_API_PREFIX}/webhooks/didit`;

/**
 * Indica si una petición va dirigida al webhook de Didit.
 *
 * @param request - Petición entrante.
 * @returns `true` si su ruta es la del webhook, con o sin diagonal final o query.
 *
 * @example
 * ```ts
 * isDiditWebhookRequest(request); // true para POST /api/v1/webhooks/didit
 * ```
 */
function isDiditWebhookRequest(request: IncomingMessage): boolean {
  const path = (request.url ?? '').split('?')[0].replace(/\/+$/, '');

  return path.toLowerCase() === DIDIT_WEBHOOK_PATH;
}

/**
 * Hace que el cuerpo del webhook de Didit llegue crudo al controlador, sin pasar por el parser JSON.
 *
 * El parser global corre antes que cualquier controlador: con un cuerpo que no es JSON respondía él
 * mismo el 400, sin verificar la firma, sin dejar fila de auditoría y citando el error de
 * `JSON.parse`. `ReceiveDiditWebhookUseCase` verifica el HMAC y audita, y sólo lo puede hacer si la
 * petición llega hasta él. `request.rawBody` sigue siendo lo que se firma; `request.body` no lo usa
 * este controlador.
 *
 * Tiene que llamarse antes de `init`/`listen`, para quedar por delante del parser JSON global.
 *
 * @param app - Aplicación creada con `rawBody: true`.
 * @returns Nada.
 *
 * @example
 * ```ts
 * const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
 * applyDiditWebhookBodyParser(app);
 * ```
 */
export function applyDiditWebhookBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('raw', { type: isDiditWebhookRequest });
}
