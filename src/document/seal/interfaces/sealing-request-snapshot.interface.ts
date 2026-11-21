import type { SealDocumentDto } from '../dto/seal-document.dto';
import type { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';

/** Versión del formato de los snapshots; súbela si cambia su forma. */
export const SEALING_REQUEST_SNAPSHOT_VERSION = 1;

/** Dónde quedó un snapshot congelado y con qué hash; es lo que guarda `document_sealing_jobs`. */
export interface SealingRequestSnapshotReference {
  /** Llave en el bucket privado `sealing-requests`. */
  objectKey: string;
  /** SHA-256 en hexadecimal de los bytes exactos del objeto. */
  hash: string;
}

/**
 * Evidencia de un firmante simple, congelada al cerrar el documento.
 *
 * Las imágenes van por referencia, no por contenido: la rúbrica es el snapshot inmutable que se
 * tomó al firmar, y la INE son las llaves de la verificación de Didit, que no se reescriben (cada
 * verificación guarda sus propias llaves). El worker descarga los bytes al enviar.
 */
export interface FrozenSimpleSignerEvidence {
  /** Fila de colaborador del firmante. */
  collaboratorId: string;
  curp: string;
  email: string;
  name: string;
  lastName: string;
  /** ISO 8601. */
  signedAt: string;
  verificationData: {
    code: string;
    verificationMethod: string;
    /** ISO 8601. */
    usedAt: string;
  };
  /** Llave de la rúbrica en el bucket `signature_images`. */
  signatureImageObjectKey: string;
  /** Llaves de la INE en el bucket privado `identity_documents`. */
  identityDocumentFrontImageKey: string;
  identityDocumentBackImageKey: string;
}

/** Payload congelado de un documento de firma simple. */
export interface SimpleSealingRequestSnapshot {
  version: typeof SEALING_REQUEST_SNAPSHOT_VERSION;
  sealType: SEALING_TYPE_ENUM.SIMPLE;
  documentId: string;
  originalHash: string;
  signedHash: string;
  /** ISO 8601: cuándo se congeló. */
  frozenAt: string;
  signatures: FrozenSimpleSignerEvidence[];
}

/**
 * Payload congelado de un documento de firma avanzada: el `SealDocumentDto` tal como se enviará,
 * armado con la evidencia OCSP ya completa de todos los firmantes.
 */
export interface AdvancedSealingRequestSnapshot {
  version: typeof SEALING_REQUEST_SNAPSHOT_VERSION;
  sealType: SEALING_TYPE_ENUM.ADVANCED;
  documentId: string;
  /** ISO 8601: cuándo se congeló. */
  frozenAt: string;
  request: SealDocumentDto;
}

export type SealingRequestSnapshot =
  | SimpleSealingRequestSnapshot
  | AdvancedSealingRequestSnapshot;
