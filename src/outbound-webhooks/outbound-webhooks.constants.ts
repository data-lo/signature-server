/**
 * Constantes del contrato público de webhooks salientes. Cambiar cualquiera de estos valores es un
 * cambio de contrato: los clientes ya verifican con ellos. Ver `README.md` del módulo.
 */

/** Versión del payload (`version`) que se envía hoy. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * Nombres de los headers de cada entrega, en minúsculas porque HTTP no distingue mayúsculas y así
 * los entrega Node. Se documentan con la capitalización de `README.md`.
 */
export const WEBHOOK_HEADERS = {
  /** Identificador de la entrega (`webhook_deliveries.id`); igual en todos sus reintentos. */
  WEBHOOK_ID: 'x-signature-webhook-id',
  /** Tipo de evento; repite `type` del payload para enrutar sin parsear el cuerpo. */
  EVENT: 'x-signature-event',
  /** Segundos Unix, en decimal, del momento en que se firmó este intento. */
  TIMESTAMP: 'x-signature-timestamp',
  /** HMAC-SHA256 en hexadecimal minúsculo de `<timestamp>.<cuerpo>`. */
  HMAC: 'x-signature-hmac',
} as const;

/** Algoritmo de la firma, en el nombre que entiende `crypto.createHmac`. */
export const WEBHOOK_SIGNATURE_ALGORITHM = 'sha256';

/** Separador entre el timestamp y el cuerpo en el texto firmado. */
export const WEBHOOK_SIGNATURE_SEPARATOR = '.';

/**
 * Diferencia máxima recomendada entre `X-Signature-Timestamp` y el reloj del receptor. Más allá,
 * el receptor debería rechazar la entrega como posible repetición maliciosa.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** Tiempo máximo que se espera la respuesta del destino en cada intento. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Esperas entre intentos automáticos, contadas desde el fin del intento anterior. Son 8 intentos en
 * total (el primero más estos 7 reintentos), repartidos en algo más de 24 horas; tras el último
 * fallo la entrega queda `FAILED`.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [
  60,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
  5 * 60 * 60,
  10 * 60 * 60,
  10 * 60 * 60,
] as const;

/** Intentos automáticos por entrega, incluido el primero. */
export const WEBHOOK_MAX_AUTOMATIC_ATTEMPTS =
  WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

/** Prefijo de los secretos que se muestran al cliente: `whsec_<base64url de 32 bytes>`. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
