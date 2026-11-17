/** Resultado de un POST concreto (`webhook_delivery_attempts.outcome`). */
export enum WEBHOOK_DELIVERY_ATTEMPT_OUTCOME_ENUM {
  /** El destino respondió `2xx`: la entrega queda confirmada. */
  SUCCEEDED = 'SUCCEEDED',
  /** El destino respondió con un estado distinto de `2xx`, incluidas las redirecciones `3xx`. */
  HTTP_ERROR = 'HTTP_ERROR',
  /** No hubo respuesta HTTP: DNS, conexión rechazada, TLS inválido o destino bloqueado. */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** El destino no respondió dentro de `WEBHOOK_REQUEST_TIMEOUT_MS`. */
  TIMEOUT = 'TIMEOUT',
}
