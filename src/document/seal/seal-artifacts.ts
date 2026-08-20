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
   * OJO con el nombre: la historia la llama "XML canónico", pero NO es XML. Seal Service la arma
   * como segmentos con su longitud en bytes al frente, unidos por `||` (ver su `seal.service.ts`),
   * justamente para que sea inequívoca sin depender de un parser. Se sirve como texto plano y con
   * ese nombre; si el producto necesita XML de verdad, el cambio es de Seal Service, no de acá.
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
    read: (seal) => seal.integritySeal?.certificatePdfBase64,
    encoding: 'base64',
    contentType: 'application/pdf',
    fileNamePrefix: 'constancia-nom151',
    extension: '.pdf',
    label: 'la constancia NOM-151',
  },
  [SEAL_ARTIFACT_ENUM.TIMESTAMP]: {
    read: (seal) => seal.timestampSeal?.tokenBase64,
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
    encoding: 'utf-8',
    contentType: 'text/plain; charset=utf-8',
    fileNamePrefix: 'cadena-canonica',
    extension: '.txt',
    label: 'la cadena canónica',
  },
};
