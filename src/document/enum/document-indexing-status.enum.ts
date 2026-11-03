/**
 * En qué punto está un trabajo de indexación de un documento (`document_indexing_jobs.status`).
 *
 * Es el estado TÉCNICO del envío al indexador y no reemplaza a `documents.is_indexable`, que sigue
 * diciendo si el documento debe aparecer en la búsqueda. Los valores van en mayúsculas, igual que
 * el resto de los enums del backend.
 *
 *  - `PENDING` -> `RECEIVED` -> `INDEXED` | `FAILED`.
 */
export enum DOCUMENT_INDEXING_STATUS_ENUM {
  /** Estado inicial de todo trabajo: todavía no lo aceptó el indexador. */
  PENDING = 'PENDING',
  /** El indexador aceptó el trabajo; desde aquí existe `external_job_id`. */
  RECEIVED = 'RECEIVED',
  /** El indexador terminó con éxito. */
  INDEXED = 'INDEXED',
  /** El indexador terminó con error; el detalle queda en `error`. */
  FAILED = 'FAILED',
}

/**
 * Estado que persiste cada `state` del webhook del indexador. Es la única lista de estados del
 * proveedor: de aquí salen también los que acepta la validación del webhook.
 */
export const DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE = {
  received: DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
  indexed: DOCUMENT_INDEXING_STATUS_ENUM.INDEXED,
  failed: DOCUMENT_INDEXING_STATUS_ENUM.FAILED,
} as const;

export type IndexerProviderState =
  keyof typeof DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE;
