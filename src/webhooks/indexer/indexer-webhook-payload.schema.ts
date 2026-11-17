import { isUUID } from 'class-validator';
import {
  DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE,
  IndexerProviderState,
} from 'src/document/enum/document-indexing-status.enum';

/**
 * Contrato de los webhooks del indexador y su validación.
 *
 * Es la segunda puerta de la recepción, después de la firma HMAC: un cuerpo auténtico pero deforme
 * no llega nunca al dominio. Los motivos terminan en `webhook_events.error` y en los logs, así que
 * sólo incluyen nombres de campos, nunca valores del cuerpo.
 */

/** Cuerpo del indexador ya validado. */
export interface IndexerWebhookPayload extends Record<string, unknown> {
  /** Id del trabajo en el indexador. */
  jobId: string;
  /** Id del documento en el indexador. No sirve para buscar nada local. */
  documentId: string;
  state: IndexerProviderState;
  /** `DocumentEntity.id`: lo que se envió en `document.index` para correlacionar la respuesta. */
  clientDocumentId: string;
  duplicate?: boolean;
  /** Detalle del fallo cuando `state` es `failed`. */
  error?: unknown;
}

/**
 * Resultado de validar una entrega. Un solo objeto con campos nullables, como el de Didit: el
 * proyecto compila sin `strictNullChecks`, y sin él TypeScript no estrecha uniones discriminadas.
 */
export interface IndexerWebhookPayloadValidation {
  payload: IndexerWebhookPayload | null;
  /** `null` cuando el cuerpo es válido. */
  reason: string | null;
}

const REQUIRED_STRING_FIELDS = ['jobId', 'documentId'] as const;

/**
 * Valida el cuerpo de una entrega del indexador.
 *
 * `clientDocumentId` se exige como UUID porque consulta una columna `uuid`: otro valor llegaría a
 * Postgres como un error de sintaxis y se respondería 500 a un cuerpo que nunca va a poder aplicarse.
 *
 * @param body - Cuerpo ya parseado; puede ser cualquier cosa.
 * @returns El payload tipado, o el motivo del rechazo en `reason`. No lanza.
 *
 * @example
 * ```ts
 * validateIndexerWebhookPayload({ jobId: 'abc' }).reason;
 * // 'Faltan campos obligatorios o no son cadenas: documentId'
 * ```
 */
export function validateIndexerWebhookPayload(
  body: unknown,
): IndexerWebhookPayloadValidation {
  if (!isObject(body)) {
    return rejected('El cuerpo del webhook no es un objeto JSON');
  }

  const missing = REQUIRED_STRING_FIELDS.filter(
    (field) => typeof body[field] !== 'string' || !body[field],
  );

  if (missing.length > 0) {
    return rejected(
      `Faltan campos obligatorios o no son cadenas: ${missing.join(', ')}`,
    );
  }

  if (!isUUID(body.clientDocumentId)) {
    return rejected('El campo clientDocumentId no es un UUID');
  }

  if (!isProviderState(body.state)) {
    return rejected('El campo state no es un estado soportado');
  }

  if (body.duplicate !== undefined && typeof body.duplicate !== 'boolean') {
    return rejected('El campo duplicate no es booleano');
  }

  return { payload: body as IndexerWebhookPayload, reason: null };
}

function rejected(reason: string): IndexerWebhookPayloadValidation {
  return { payload: null, reason };
}

function isProviderState(value: unknown): value is IndexerProviderState {
  return (
    typeof value === 'string' &&
    Object.keys(DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE).includes(value)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
