import { Injectable } from '@nestjs/common';

import { DocumentAuditXmlService } from '../audit-xml/document-audit-xml.service';

/** El XML de auditoría listo para responder por HTTP. */
export interface PublicDocumentAuditXml {
  content: Buffer;
  contentType: string;
  fileName: string;
}

/**
 * Tipo MIME de la descarga, sin `charset`.
 *
 * La declaración `<?xml version="1.0" encoding="UTF-8"?>` del propio archivo ya fija la
 * codificación, y RFC 7303 dice que para `application/xml` sin `charset` manda esa declaración.
 * Un parámetro de más aquí sería redundante y contradecirlo sería peor que omitirlo.
 */
const AUDIT_XML_CONTENT_TYPE = 'application/xml';

/**
 * `GET /document/public/:id/audit-xml`: arma en el momento el expediente de auditoría completo del
 * documento —sus tres PDFs, la evidencia del sello y la acreditación de cada firmante— y lo
 * devuelve como un XML descargable.
 *
 * **No persiste nada.** Ni en PostgreSQL ni en MinIO: se lee lo que ya existe, se serializa en
 * memoria y se responde.
 *
 * **Es el registro de verificación, byte a byte.** No lleva `generatedAt` ni ningún otro valor del
 * momento de la descarga: dos descargas con la misma evidencia son el mismo archivo, y su SHA-256
 * es el que guarda `document_seals.verification_record_digest`. Por eso la consulta pública
 * `POST /document/public/verify` puede reconocerlo (antes llevaba `generatedAt` y ningún XML
 * descargado coincidía con su huella).
 *
 * Pública como el resto de la vista pública (ver `GetPublicSealArtifactUseCase`): es el mismo
 * material de verificación que ya sirven los botones de esa pantalla, reunido en un solo archivo.
 * Lo que sí es nuevo respecto de esos botones es cuánto se publica —los PDFs completos, la CURP,
 * el IP y la ubicación de cada firmante— sobre una URL que sólo exige conocer el UUID; si eso se
 * quiere restringir, el cambio es quitar `@SkipJwtAuth()` de la ruta, no tocar este caso de uso.
 */
@Injectable()
export class GetPublicDocumentAuditXmlUseCase {
  constructor(private readonly auditXml: DocumentAuditXmlService) {}

  /**
   * Genera la descarga del XML de auditoría.
   *
   * @param documentId - Documento firmado.
   * @returns El archivo, su tipo MIME y su nombre.
   *
   * @throws {NotFoundException} Si el documento no existe o todavía no está en `SIGNED`.
   * @throws {IncompleteAuditEvidenceException} Si falta evidencia obligatoria.
   *
   * @example
   * ```ts
   * const { content, fileName } = await useCase.execute(documentId);
   * ```
   */
  async execute(documentId: string): Promise<PublicDocumentAuditXml> {
    const xml = await this.auditXml.build(documentId);

    return {
      content: Buffer.from(xml, 'utf-8'),
      contentType: AUDIT_XML_CONTENT_TYPE,
      fileName: `auditoria-${documentId}.xml`,
    };
  }
}
