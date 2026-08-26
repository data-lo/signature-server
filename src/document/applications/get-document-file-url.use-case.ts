import { Injectable } from '@nestjs/common';

import { DocumentService } from '../document.service';

/**
 * `GET /document/file/:id`: URL prefirmada del PDF, para el visor.
 *
 * El control de acceso es lo primero y es su propio paso: la pantalla de detalle y la descarga
 * del archivo se comprueban por separado, y cuando sólo se validaba la primera, el visor pedía
 * este endpoint y recibía 403 —el documento se abría pero el archivo no cargaba, y la firma
 * quedaba a medias—.
 *
 * De qué bucket sale el archivo depende del estado del documento (creado, parcialmente firmado,
 * firmado, rechazado, cancelado): eso lo resuelve el servicio, que es donde vive ese mapa.
 */
@Injectable()
export class GetDocumentFileUrlUseCase {
  constructor(private readonly documentService: DocumentService) {}

  async execute(documentId: string, userId: string) {
    await this.documentService.assertUserHasAccess(documentId, userId);

    return this.documentService.getDocumentMinioURL(documentId);
  }
}
