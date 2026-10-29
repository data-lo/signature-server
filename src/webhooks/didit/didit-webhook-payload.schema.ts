/**
 * Contrato de los webhooks de Didit y su validación.
 *
 * Vive en `webhooks` y no en `identity-verification`, y es una función pura y no un caso de uso,
 * porque no decide nada sobre la identidad de nadie: sólo responde si el cuerpo que llegó tiene
 * la forma que Didit documenta. Es la segunda puerta de la recepción —después de la firma HMAC—
 * y existe para que un cuerpo auténtico pero deforme (un cambio de contrato del proveedor, un
 * evento de otro producto apuntado a nuestra URL) no llegue nunca al dominio a medio interpretar.
 *
 * **Nunca incluye valores del cuerpo en los mensajes de error**, salvo el `status`, que es
 * vocabulario del proveedor y no un dato del titular: los motivos terminan en `webhook_events.error`
 * y en los logs.
 */

/**
 * Estados que este servidor sabe interpretar. Cualquier otro se rechaza en la puerta.
 *
 * **Tiene que cubrir exactamente lo mismo que `DIDIT_STATUS_MAP`** (en
 * ProcessDiditVerificationResultUseCase). Cuando esta lista se quedaba corta, el efecto no era
 * "se ignora el evento" sino un 400 al proveedor: Didit da la entrega por fallida y la reintenta
 * en bucle, y la fila queda en `webhook_events` como payload inválido pese a ser un cuerpo
 * legítimo. `Not Started` y `Kyc Expired` llegaban de verdad y caían justo ahí, aunque el
 * dominio ya sabía traducirlos.
 */
export const DIDIT_WEBHOOK_STATUSES = [
  'Not Started',
  'In Progress',
  'In Review',
  'Approved',
  'Declined',
  'Abandoned',
  'Expired',
  'Kyc Expired',
] as const;

export type DiditWebhookStatus = (typeof DIDIT_WEBHOOK_STATUSES)[number];

/**
 * Índice por forma normalizada: Didit escribe `In Progress` en el webhook e `in_progress` en
 * algunos endpoints de su API. Se acepta cualquiera de las dos y se conserva el valor original
 * en el payload, que es lo que se persiste como evidencia.
 */
const STATUS_BY_NORMALIZED_VALUE = new Map<string, DiditWebhookStatus>(
  DIDIT_WEBHOOK_STATUSES.map((status) => [normalize(status), status]),
);

/**
 * Campos que Didit manda en toda entrega, sea cual sea el estado.
 *
 * `vendor_data` es nuestro `userId`: sin él una sesión creada fuera de este servidor podría
 * intentar aplicarse a un intento local. `event_id` es la clave de idempotencia y `session_id`
 * la que ata la entrega al intento, así que ninguno de los dos es opcional.
 */
const REQUIRED_STRING_FIELDS = [
  'application_id',
  'event_id',
  'session_id',
  'webhook_type',
  'workflow_id',
  'vendor_data',
] as const;

/**
 * Cuerpo de Didit ya validado.
 *
 * Es una intersección con `Record<string, unknown>` a propósito: el dominio recibe el payload
 * completo tal como llegó —incluidos los campos que este esquema no conoce— y este tipo sólo
 * garantiza que los que sí conoce están y son del tipo correcto.
 */
export type DiditWebhookPayload = Record<string, unknown> & {
  application_id: string;
  event_id: string;
  session_id: string;
  /**
   * El valor **tal como lo mandó el proveedor**, no la forma canónica: la fila de
   * `webhook_events` y lo que recibe el dominio tienen que ser el mismo cuerpo, byte por byte.
   * La forma canónica se devuelve aparte, en `status` del resultado de validación.
   */
  status: string;
  timestamp: number | string;
  webhook_type: string;
  workflow_id: string;
  vendor_data: string;
  /** Sólo obligatorio cuando el resultado es `Approved`. */
  decision?: Record<string, unknown>;
};

/**
 * Resultado de validar una entrega.
 *
 * Un solo objeto con campos nullables en vez de una unión discriminada: este proyecto compila
 * con `strictNullChecks: false`, y sin él TypeScript no estrecha uniones por un discriminante
 * booleano, así que la unión obligaría a castear en cada uso. `reason` es la señal: si trae
 * texto, el cuerpo no cumple el contrato y `payload` no debe usarse.
 */
export interface DiditWebhookPayloadValidation {
  payload: DiditWebhookPayload | null;
  /** `payload.status` reducido a una de las variantes soportadas. */
  status: DiditWebhookStatus | null;
  /** `null` cuando el cuerpo es válido. */
  reason: string | null;
}

/**
 * Valida el cuerpo de una entrega de Didit.
 *
 * @returns El payload tipado, o el motivo del rechazo en `reason`. No lanza: quien llama decide
 *   si eso es un 400, una fila de auditoría o ambas cosas.
 */
export function validateDiditWebhookPayload(
  body: unknown,
): DiditWebhookPayloadValidation {
  if (!isObject(body)) {
    return rejected('El cuerpo del webhook no es un objeto JSON');
  }

  const missing = REQUIRED_STRING_FIELDS.filter(
    (field) => !isNonEmptyString(body[field]),
  );

  if (missing.length > 0) {
    return rejected(
      `Faltan campos obligatorios o no son cadenas: ${missing.join(', ')}`,
    );
  }

  if (!isTimestamp(body.timestamp)) {
    return rejected('El campo timestamp no es un entero de segundos válido');
  }

  const status = toStatus(body.status);

  if (!status) {
    return rejected(`Estado de Didit no soportado: "${String(body.status)}"`);
  }

  /**
   * La decisión sólo se exige al aprobar. Es el único evento que otorga algo —mueve al usuario a
   * SIGNATURE_PENDING y habilita su firma—, así que aprobar sin veredicto que auditar dejaría la
   * credencial sin evidencia de por qué se concedió. En los demás estados `decision` es opcional:
   * `In Progress` nunca la trae, y un rechazo puede llegar sin ella.
   */
  if (status === 'Approved' && !isObject(body.decision)) {
    return rejected('Un evento Approved debe traer decision como objeto');
  }

  return { payload: body as DiditWebhookPayload, status, reason: null };
}

function rejected(reason: string): DiditWebhookPayloadValidation {
  return { payload: null, status: null, reason };
}

/**
 * `timestamp` llega como entero de segundos, pero se acepta también su forma en cadena: es el
 * único campo del contrato que Didit ha entregado de las dos maneras.
 */
function isTimestamp(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return isNonEmptyString(value) && Number.isFinite(Number(value));
}

function toStatus(value: unknown): DiditWebhookStatus | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  return STATUS_BY_NORMALIZED_VALUE.get(normalize(value)) ?? null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, '');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
