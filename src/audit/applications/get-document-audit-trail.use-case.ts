import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit.service';

/**
 * `GET /audit/document/:documentId`: la cadena de auditoría completa de un documento, en el
 * orden en que ocurrieron los eventos.
 *
 * Se devuelve descifrada porque el sentido de esta consulta es poder auditar: un `cipher` opaco
 * no le sirve a nadie para comprobar qué pasó. Los hashes viajan junto al contenido para que
 * quien reciba la respuesta pueda rehacer la verificación por su cuenta.
 *
 * Un documento sin registros es 404 y no una lista vacía: si se pide la traza de un documento
 * que no dejó ninguna, lo que hay que decir es que no existe esa traza, no insinuar que el
 * documento existió y no hizo nada.
 */
@Injectable()
export class GetDocumentAuditTrailUseCase {
  constructor(private readonly auditService: AuditService) {}

  async execute(documentId: string): Promise<Record<string, any>[]> {
    const records = await this.auditService.findByDocumentId(documentId);

    if (!records.length) {
      throw new NotFoundException(
        `No se encontraron registros de auditoría para el documento ${documentId}`,
      );
    }

    return Promise.all(
      records.map((record) => this.auditService.decrypt(record)),
    );
  }
}
