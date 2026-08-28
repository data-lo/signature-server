import { SealEntity } from './entities/seal.entity';

/**
 * Los tres artefactos de la constancia del PSC que la vista pública deja descargar (ver historia
 * "Actualizar vista pública de verificación de documentos según estado y tipo de firma").
 *
 * Los valores son los que viajan en la URL (`GET /document/public/:id/seal/:artifact`), así que
 * cambiarlos rompe enlaces ya compartidos.
 */
export enum SEAL_ARTIFACT_ENUM {
  /** Constancia de conservación NOM-151 en PDF, tal como la emitió el PSC. */
  NOM151 = 'nom151',
  /** Token de sello de tiempo RFC 3161. */
  TIMESTAMP = 'timestamp',
  /**
   * Cadena canónica que se selló: la preimagen literal del hash.
   *
   * **El dato en sí no es XML.** Seal Service lo arma como segmentos con su longitud en bytes al
   * frente, unidos por `||` (ver su `seal.service.ts`), justamente para que sea inequívoco sin
   * depender de un parser. Ese formato NO se puede cambiar: es la preimagen de `signature_hash`,
   * y tocarlo invalidaría la verificación de todos los sellos ya emitidos.
   *
   * Se entrega envuelto en un documento XML (`toCanonicalXml`) porque es como el producto lo pide
   * y lo consume. El envoltorio no altera la cadena: la conserva íntegra dentro del nodo, sólo con
   * el escapado que exige XML.
   */
  CANONICAL = 'canonical',
}

/** Lo que un artefacto entrega listo para responder por HTTP. */
export interface PublicSealArtifact {
  content: Buffer;
  contentType: string;
  fileName: string;
}

interface SealArtifactDescriptor {
  /** Cómo sacar el valor crudo del sello persistido. `null`/vacío = ese artefacto no se emitió. */
  read: (seal: SealEntity) => string | null | undefined;
  /**
   * Convierte el valor crudo en el contenido final del archivo. Sin definir, se entrega tal cual.
   *
   * Sólo la cadena canónica lo usa, para envolverse en un documento XML. Los binarios del PSC se
   * sirven exactamente como los emitió: cualquier transformación invalidaría la evidencia.
   */
  render?: (raw: string, seal: SealEntity) => string;
  /** Codificación del valor crudo: base64 para los binarios del PSC, utf-8 para la cadena canónica. */
  encoding: BufferEncoding;
  contentType: string;
  fileNamePrefix: string;
  extension: string;
  /** Cómo se nombra el artefacto en el 404, en un español legible para quien consulta. */
  label: string;
}

/**
 * Escapa el texto que va dentro de un nodo o atributo XML.
 *
 * La cadena canónica puede traer cualquier carácter que venga del certificado o del nombre del
 * firmante, así que sin esto un `&` o un `<` producirían un XML que no abre — justo lo que este
 * envoltorio existe para evitar.
 */
function escapeXml(value: string | null | undefined): string {
  // Total a propósito: un atributo sin valor no puede tumbar la descarga de la evidencia, que es
  // lo único que el usuario vino a buscar.
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Envuelve la cadena canónica en un documento XML válido.
 *
 * **La cadena es la preimagen literal del hash sellado**, así que el texto se conserva byte por
 * byte dentro del nodo; lo único que cambia es el escapado XML. Para recomputar
 * `sha256` y comprobar el sello hay que desescapar el contenido del nodo primero — de ahí que el
 * hash y el algoritmo viajen como atributos, para poder verificarlo sin consultar nada más.
 */
function toCanonicalXml(raw: string, seal: SealEntity): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<canonicalPayload documentId="${escapeXml(seal.documentId)}" signatureHash="${escapeXml(
      seal.signatureHash,
    )}" hashAlgorithm="sha256">${escapeXml(raw)}</canonicalPayload>`,
    '',
  ].join('\n');
}

export const SEAL_ARTIFACT_DESCRIPTORS: Record<
  SEAL_ARTIFACT_ENUM,
  SealArtifactDescriptor
> = {
  [SEAL_ARTIFACT_ENUM.NOM151]: {
    read: (seal) => seal.integrityEvidence?.certificatePdfBase64,
    encoding: 'base64',
    contentType: 'application/pdf',
    fileNamePrefix: 'constancia-nom151',
    extension: '.pdf',
    label: 'la constancia NOM-151',
  },
  [SEAL_ARTIFACT_ENUM.TIMESTAMP]: {
    read: (seal) => seal.timestampEvidence?.fileBase64,
    encoding: 'base64',
    // Tipo MIME del TimeStampResp de RFC 3161. `.tsr` es la extensión con la que `openssl ts`
    // espera encontrarlo, que es con lo que se verifica.
    contentType: 'application/timestamp-reply',
    fileNamePrefix: 'sello-de-tiempo',
    extension: '.tsr',
    label: 'el sello de tiempo',
  },
  [SEAL_ARTIFACT_ENUM.CANONICAL]: {
    read: (seal) => seal.canonicalPayload,
    render: toCanonicalXml,
    encoding: 'utf-8',
    contentType: 'application/xml; charset=utf-8',
    fileNamePrefix: 'cadena-canonica',
    extension: '.xml',
    label: 'la cadena canónica',
  },
};
