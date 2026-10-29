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
   * XML canónico que se selló: la preimagen literal del hash.
   *
   * Seal Service lo emite como XML con su propio namespace y lo transporta en Base64;
   * `SealMapper.decodeCanonicalXml` lo deja en claro al persistirlo. Se entrega intacto: es lo
   * único que conserva la propiedad que hace verificable la constancia — `sha256` del archivo
   * descargado reproduce `signature_hash`. Envolverlo o reescribirlo la rompería.
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
  /** Codificación del valor crudo: base64 para los binarios del PSC, utf-8 para la cadena canónica. */
  encoding: BufferEncoding;
  contentType: string;
  fileNamePrefix: string;
  extension: string;
  /** Cómo se nombra el artefacto en el 404, en un español legible para quien consulta. */
  label: string;
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
    /**
     * Se entrega intacto, sin transformarlo: el dato ya es el XML que emitió el proveedor. Antes
     * se envolvía en un elemento sintético porque se creía que era una cadena de segmentos
     * imposible de expresar como XML; no lo es (ver `SealMapper.decodeCanonicalXml`).
     */
    encoding: 'utf-8',
    contentType: 'application/xml; charset=utf-8',
    fileNamePrefix: 'xml-canonico',
    extension: '.xml',
    label: 'el XML canónico',
  },
};
