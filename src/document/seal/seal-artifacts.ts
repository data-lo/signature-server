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
     * Sin `render`: el dato YA es el XML canónico que emitió el proveedor, con su propio
     * namespace, y se entrega intacto.
     *
     * Antes se envolvía en un elemento sintético porque se creía que el contenido era una cadena
     * de segmentos imposible de expresar como XML. No lo es: Seal Service devuelve XML y sólo lo
     * transportaba en Base64 (ver `SealMapper.decodeCanonicalXml`). Entregarlo tal cual es además
     * lo único que conserva la propiedad que hace verificable la constancia — `sha256` del
     * archivo descargado reproduce `signature_hash`, sin desescapar nada.
     */
    encoding: 'utf-8',
    contentType: 'application/xml; charset=utf-8',
    fileNamePrefix: 'xml-canonico',
    extension: '.xml',
    label: 'el XML canónico',
  },
};
