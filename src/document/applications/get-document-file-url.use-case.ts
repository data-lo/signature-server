import { Injectable } from '@nestjs/common';

import { DocumentService } from '../document.service';

/**
 * Devuelve la URL prefirmada del PDF (`GET /document/file/:id`), para el visor y para la descarga.
 *
 * Ambas comparten ruta porque comparten permiso, bucket y objeto; sólo cambia con qué nombre baja el
 * archivo, y eso lo decide `asAttachment` (ver `getDocumentMinioURL`).
 *
 * El control de acceso es lo primero y es su propio paso: la pantalla de detalle y la descarga se
 * comprueban por separado, y cuando sólo se validaba la primera el visor recibía 403 —el documento
 * se abría pero el archivo no cargaba.
 *
 * De qué bucket sale depende del estado del documento, y ese mapa vive en el servicio.
 */
@Injectable()
export class GetDocumentFileUrlUseCase {
  constructor(private readonly documentService: DocumentService) {}

  async execute(
    documentId: string,
    userId: string,
    { asAttachment = false }: { asAttachment?: boolean } = {},
  ) {
    await this.documentService.assertUserHasAccess(documentId, userId);

    return this.documentService.getDocumentMinioURL(documentId, {
      asAttachment,
    });
  }
}
