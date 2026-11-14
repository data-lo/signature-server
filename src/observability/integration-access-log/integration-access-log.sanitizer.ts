import { isIP } from 'net';

import { REQUEST_ID_PATTERN } from '../request-context/request-context.constants';
import {
  INTEGRATION_ACCESS_LOG_EVENT,
  INTEGRATION_ACCESS_OUTCOME_ENUM,
  IntegrationAccessLogEvent,
} from './integration-access-log.interface';

/** Estado que se registra cuando el cliente cortó antes de recibir la respuesta (como métricas). */
export const CLIENT_CLOSED_STATUS = 499;

/** Plantilla de ruta que se registra si ningún controller resolvió la petición. */
export const UNMATCHED_ROUTE = 'unmatched';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Plantilla de Express: segmentos literales o `:param`, sin valores reales. */
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9/_:.-]{0,255}$/;
const METHOD = /^[A-Z]{1,10}$/;
/** Códigos de error de la API de integración: `API_KEY_INVALID`, `INVALID_PAYLOAD`… */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_TYPE = /^\w{1,64}$/;

/** Lo que se sabe de una petición al cerrarse, antes de sanear. */
export interface IntegrationAccessLogInput {
  requestId: unknown;
  method: unknown;
  route: unknown;
  /** `null` si el cliente cortó antes de recibir la respuesta. */
  statusCode: number | null;
  durationMs: number;
  apiKeyId: unknown;
  organizationId: unknown;
  documentId: unknown;
  ip: unknown;
  errorCode: unknown;
  idempotencyReplayed?: unknown;
  errorType?: unknown;
}

/**
 * Arma el evento `integration.http_request` con lista blanca de campos y formato validado en cada
 * uno: lo que no cumple su formato se registra como `null` (u omitido, si es opcional), nunca
 * crudo.
 *
 * Es la última barrera contra filtraciones: aunque alguien anotara por error un correo, un
 * fragmento de la API key o un mensaje de excepción, ninguno de esos valores pasa por las
 * expresiones de UUID, IP, código o plantilla de ruta.
 *
 * @param input - Datos de la petición al cerrarse.
 * @returns El evento listo para escribirse.
 *
 * @example
 * ```ts
 * buildIntegrationAccessLogEvent({ requestId: 'erp-1', method: 'POST', route: '/api/v1/integration/documents', statusCode: 201, durationMs: 842.4, apiKeyId: null, organizationId: null, documentId: null, ip: '10.0.0.1', errorCode: null });
 * // { event: 'integration.http_request', requestId: 'erp-1', …, durationMs: 842, outcome: 'success', … }
 * ```
 */
export function buildIntegrationAccessLogEvent(
  input: IntegrationAccessLogInput,
): IntegrationAccessLogEvent {
  const statusCode = input.statusCode ?? CLIENT_CLOSED_STATUS;
  const event: IntegrationAccessLogEvent = {
    event: INTEGRATION_ACCESS_LOG_EVENT,
    requestId: matching(input.requestId, REQUEST_ID_PATTERN) ?? 'unknown',
    method: matching(input.method, METHOD) ?? 'UNKNOWN',
    route: matching(input.route, ROUTE_TEMPLATE) ?? UNMATCHED_ROUTE,
    statusCode,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    outcome: outcomeOf(input.statusCode),
    apiKeyId: matching(input.apiKeyId, UUID),
    organizationId: matching(input.organizationId, UUID),
    documentId: matching(input.documentId, UUID),
    ip: typeof input.ip === 'string' && isIP(input.ip) ? input.ip : null,
    errorCode: matching(input.errorCode, ERROR_CODE),
  };

  if (typeof input.idempotencyReplayed === 'boolean') {
    event.idempotencyReplayed = input.idempotencyReplayed;
  }
  const errorType = matching(input.errorType, ERROR_TYPE);
  if (errorType && statusCode >= 400) event.errorType = errorType;

  return event;
}

/**
 * El resultado de una petición según su estado.
 *
 * @param statusCode - Estado enviado, o `null` si el cliente cortó antes.
 * @returns `success`, `client_error`, `server_error` o `client_closed`.
 *
 * @example
 * ```ts
 * outcomeOf(422); // 'client_error'
 * outcomeOf(null); // 'client_closed'
 * ```
 */
export function outcomeOf(
  statusCode: number | null,
): INTEGRATION_ACCESS_OUTCOME_ENUM {
  if (statusCode === null) return INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_CLOSED;
  if (statusCode >= 500) return INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR;
  if (statusCode >= 400) return INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_ERROR;
  return INTEGRATION_ACCESS_OUTCOME_ENUM.SUCCESS;
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}
