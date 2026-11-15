/** Nombre del evento de acceso a la API de integración. */
export const INTEGRATION_ACCESS_LOG_EVENT = 'integration.http_request';

/** Cómo terminó la petición, para filtrar sin comparar rangos de `statusCode`. */
export enum INTEGRATION_ACCESS_OUTCOME_ENUM {
  /** 1xx, 2xx o 3xx. */
  SUCCESS = 'success',
  /** 4xx. */
  CLIENT_ERROR = 'client_error',
  /** 5xx. */
  SERVER_ERROR = 'server_error',
  /** El cliente cortó la conexión antes de recibir la respuesta completa. */
  CLIENT_CLOSED = 'client_closed',
}

/**
 * Evento `integration.http_request`: una línea por petición a `/api/v1/integration/*`, emitida al
 * cerrarse la respuesta por `IntegrationAccessLogMiddleware`.
 *
 * Todos los campos obligatorios están siempre presentes; los que no se conocen van en `null`. Los
 * opcionales sólo aparecen cuando tienen valor. Ningún campo lleva headers, body, query, archivos,
 * correos, nombres ni mensajes de error: sólo identificadores con formato validado
 * (`buildIntegrationAccessLogEvent`).
 */
export interface IntegrationAccessLogEvent {
  event: typeof INTEGRATION_ACCESS_LOG_EVENT;
  /** El mismo valor que el header `X-Request-Id` de la respuesta. */
  requestId: string;
  method: string;
  /**
   * Plantilla de la ruta (`/api/v1/integration/documents/:documentId/signing-access`), nunca la
   * URL real; `unmatched` si ningún controller la resolvió (404 de ruta inexistente).
   */
  route: string;
  /** Estado HTTP enviado; 499 si el cliente cortó antes (`outcome: client_closed`). */
  statusCode: number;
  /** Desde que la petición entró al servidor hasta que se cerró la respuesta, en ms enteros. */
  durationMs: number;
  outcome: INTEGRATION_ACCESS_OUTCOME_ENUM;
  /** `api_keys.id` de la llave autenticada; `null` si no llegó a autenticarse. */
  apiKeyId: string | null;
  /** Organización de la llave; `null` si no llegó a autenticarse. */
  organizationId: string | null;
  /** Documento de la operación: el `:documentId` de la ruta o el creado por el alta. */
  documentId: string | null;
  /** IP del cliente; `null` si no se pudo resolver una IP válida. */
  ip: string | null;
  /** `error.code` que respondió `IntegrationErrorFilter`; `null` si no hubo error o no lo atendió él. */
  errorCode: string | null;
  /** `true` si el alta devolvió un documento ya creado con el mismo `Idempotency-Key`. */
  idempotencyReplayed?: boolean;
  /** Clase de la excepción que produjo el error (`InvalidApiKeyException`), sin mensaje ni stack. */
  errorType?: string;
}

/** Lo que las piezas de la petición anotan para el log (ver `annotateIntegrationAccess`). */
export interface IntegrationAccessAnnotations {
  documentId?: string;
  idempotencyReplayed?: boolean;
  errorCode?: string;
  errorType?: string;
}
