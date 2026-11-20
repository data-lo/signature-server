import type {
  Nom151SealResponse,
  TimestampSealResponse,
} from './seal-document-response.interface';

/** Estado de una operación en Seal Service (`GET /seal/operations/:idempotencyKey`). */
export enum SEAL_OPERATION_STATUS_ENUM {
  NOT_FOUND = 'NOT_FOUND',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED',
}

/** Códigos de error del contrato de idempotencia de Seal Service. */
export enum SEAL_OPERATION_ERROR_CODE_ENUM {
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  SEAL_RECONCILIATION_REQUIRED = 'SEAL_RECONCILIATION_REQUIRED',
}

/**
 * Respuesta de `GET /seal/operations/:idempotencyKey`.
 *
 * En `COMPLETED` trae la misma evidencia que devolvió el sellado, salvo la cadena canónica: Seal
 * Service no la guarda (en firma simple lleva datos personales). Para obtenerla, se repite el
 * sellado con el mismo payload y la misma clave, que devuelve la evidencia sin emitir otra vez.
 */
export interface SealOperationLookup {
  idempotencyKey: string;
  status: SEAL_OPERATION_STATUS_ENUM;
  operationType?: 'ADVANCED_SIGNATURE' | 'SIMPLE_SIGNATURE';
  documentId?: string;
  requestHash?: string;
  evidence?: {
    hashHex: string;
    hashAlgorithm: string;
    hashVersion: string;
    sealedAt: string;
    timeStamp: TimestampSealResponse;
    nom151: Nom151SealResponse;
  };
  /** Identificadores en el PSC de lo emitido hasta ahora. */
  provider?: { timeStampUuid: string | null; nom151Uuid: string | null };
  error?: { code: string | null; message: string | null };
}

/** Cuerpo de `202 Accepted`: otra petición con la misma clave está emitiendo. */
export interface SealOperationProcessingResponse {
  idempotencyKey: string;
  status: SEAL_OPERATION_STATUS_ENUM.PROCESSING;
}
