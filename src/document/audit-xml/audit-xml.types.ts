/**
 * Los datos que el XML de auditoría serializa, ya resueltos: archivos descargados de MinIO en
 * Base64, evidencia del sello y firmantes con su acreditación.
 *
 * El armado del XML (`audit-xml.builder.ts`) no consulta nada — recibe esto y lo escribe. La
 * separación es lo que permite probar el formato del archivo sin base de datos ni MinIO, y es
 * también lo que garantiza el criterio de "no persistir": esta estructura vive en memoria durante
 * la petición y nada la escribe a ningún lado.
 */

/** Un PDF del documento, tal como está guardado en su bucket. */
export interface AuditXmlDocumentFile {
  /** Rol del archivo en el expediente: el original, el firmado o el definitivo con hoja de firmas. */
  role: 'original' | 'signed' | 'finalized';
  /** Bucket de MinIO del que salió, para que la auditoría sepa qué copia está leyendo. */
  bucket: string;
  objectKey: string;
  mimeType: string;
  /** Contenido en Base64. `null` cuando el archivo no está disponible (ver `unavailableReason`). */
  contentBase64: string | null;
  /**
   * Por qué no se pudo incluir el archivo. Se emite en el XML en vez de omitir el nodo: un
   * expediente al que le falta una pieza tiene que decirlo, no callarlo.
   */
  unavailableReason?: string;
}

/** Evidencia del sellado ante el PSC. `null` entero cuando el documento no se selló. */
export interface AuditXmlSeal {
  /** `document_seals.signature_hash`. */
  signatureHash: string | null;
  /**
   * `document_seals.canonical_payload`, TEXTO UTF-8 tal cual se selló.
   *
   * No es Base64 ni XML: es la preimagen literal del hash (ver `SEAL_ARTIFACT_ENUM.CANONICAL`).
   * Viaja escapada dentro de su nodo y hay que desescaparla para recomputar el sha256.
   */
  canonicalPayload: string | null;
  /** `document_seals.timestamp_evidence.fileBase64` — TimeStampResp RFC 3161 en Base64. */
  timestampEvidenceBase64: string | null;
  /** `document_seals.integrity_evidence.fileBase64` — evidencia NOM-151 del PSC en Base64. */
  nom151EvidenceBase64: string | null;
  /** PDF de la constancia NOM-151, cuando el PSC lo emitió. */
  nom151CertificatePdfBase64: string | null;
  /** Momento en que el PSC emitió la constancia (ISO 8601). */
  sealedAt: string | null;
}

/** Rúbrica estampada por un firmante de firma simple. */
export interface AuditXmlSimpleSignature {
  /** `collaborators.signature_snapshot_object_key`, o la firma vigente del perfil como respaldo. */
  objectKey: string | null;
  /** PNG en Base64. `null` cuando el firmante no tiene rúbrica registrada. */
  imageBase64: string | null;
  unavailableReason?: string;
}

/** Un firmante del documento con toda su evidencia de auditoría. */
export interface AuditXmlSigner {
  /** Id de la fila de colaborador: es como se identifica un firmante sin publicar datos personales. */
  id: string;
  email: string | null;
  curp: string | null;
  /** ISO 8601. */
  signedAt: string | null;
  /** `simple` | `fiel`, o `null` en filas anteriores a que existiera la columna. */
  signatureType: string | null;
  status: string;
  ipAddress: string | null;
  geoLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  } | null;
  /**
   * `collaborators.advanced_signature` CRUDO, tal como está en la columna jsonb.
   *
   * Se serializa genéricamente (ver `audit-xml.builder.ts`) y no campo por campo: la historia pide
   * "todos los campos disponibles", y una lista fija de campos dejaría fuera en silencio cualquier
   * cosa que el firmado agregue después. Nunca contiene la llave privada ni la contraseña.
   */
  advancedSignature: Record<string, unknown> | null;
  /** Sólo para firma simple. `null` para firma avanzada. */
  simpleSignature: AuditXmlSimpleSignature | null;
}

/** Todo lo que el XML de auditoría de un documento contiene. */
export interface DocumentAuditXmlData {
  /** ISO 8601 del momento en que se generó el archivo. */
  generatedAt: string;
  document: {
    id: string;
    fileName: string;
    /** Tipo MIME del documento (`documents.file_type`). */
    mimeType: string;
    status: string;
    totalPages: number | null;
    originalHash: string | null;
    signedHash: string | null;
    /** ISO 8601. */
    signedAt: string | null;
  };
  files: AuditXmlDocumentFile[];
  seal: AuditXmlSeal | null;
  signers: AuditXmlSigner[];
}
