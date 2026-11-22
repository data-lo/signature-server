import { MAX_PDF_FILE_SIZE_BYTES } from 'src/common/constants/file-upload.constants';

/** Resultado de la verificación pública de un archivo. */
export enum VERIFICATION_STATUS_ENUM {
  /** El SHA-256 coincide con una huella registrada. */
  VALID = 'VALID',
  /** XML con `documentId` existente pero con otro SHA-256: fue modificado. */
  COMPROMISED = 'COMPROMISED',
  /** No hay documento verificable asociado al archivo. */
  NOT_FOUND = 'NOT_FOUND',
  /** No es un XML de auditoría ni un PDF (extensión o tipo MIME), o no llegó archivo. */
  UNSUPPORTED_FILE = 'UNSUPPORTED_FILE',
  /** El archivo dice ser XML o PDF pero no se pudo procesar (contenido, tamaño, XML inseguro). */
  INVALID_FILE = 'INVALID_FILE',
}

/** Qué artefacto se verificó. */
export enum VERIFICATION_ARTIFACT_TYPE_ENUM {
  AUDIT_XML = 'AUDIT_XML',
  FINAL_DOCUMENT = 'FINAL_DOCUMENT',
}

/** Mensaje para el usuario de cada estado. Siempre el mismo por estado. */
export const VERIFICATION_MESSAGES: Record<VERIFICATION_STATUS_ENUM, string> = {
  [VERIFICATION_STATUS_ENUM.VALID]:
    'El archivo corresponde a un documento verificable.',
  [VERIFICATION_STATUS_ENUM.COMPROMISED]:
    'El archivo cargado no corresponde a la evidencia registrada para este documento. Su integridad no puede validarse.',
  [VERIFICATION_STATUS_ENUM.NOT_FOUND]:
    'No existe un documento verificable asociado a este archivo.',
  [VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE]:
    'Selecciona un archivo XML de auditoría o un PDF final.',
  [VERIFICATION_STATUS_ENUM.INVALID_FILE]:
    'No fue posible procesar el archivo seleccionado.',
};

/** Cuerpo de `POST /document/public/verify` (dentro de `data`). */
export interface DocumentVerificationResponse {
  status: VERIFICATION_STATUS_ENUM;
  artifactType?: VERIFICATION_ARTIFACT_TYPE_ENUM;
  message: string;
  /** Sólo en `VALID`: en `COMPROMISED` y `NOT_FOUND` no se publica nada del documento. */
  document?: {
    id: string;
    fileName: string;
    /** ISO 8601. */
    signedAt: string | null;
  };
}

/**
 * Margen sobre `MAX_PDF_FILE_SIZE_BYTES` para el PDF final: lleva el PDF firmado (que ya puede
 * pesar el máximo de un documento) más la hoja de firmas y evidencia anexada.
 */
const FINAL_DOCUMENT_SHEET_MARGIN_BYTES = 5 * 1024 * 1024;

/** Tope del PDF final: el máximo de un documento más la hoja de firmas. */
export const MAX_VERIFICATION_PDF_BYTES =
  MAX_PDF_FILE_SIZE_BYTES + FINAL_DOCUMENT_SHEET_MARGIN_BYTES;

/**
 * Tope del XML de auditoría. El XML lleva en Base64 (+33 %) el PDF original, el firmado y el final
 * —hasta ~3 × 25 MB— más la rúbrica y la INE de cada firmante simple. 128 MiB cubre un documento
 * del máximo permitido con varios firmantes. Se procesa en streaming: el tope limita el ancho de
 * banda, no la memoria.
 */
export const MAX_VERIFICATION_XML_BYTES = 128 * 1024 * 1024;
