import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit.service';

/**
 * Devuelve la cadena de auditoría completa de un documento en orden cronológico
 * (`GET /audit/document/:documentId`).
 *
 * La devuelve descifrada porque el sentido de la consulta es auditar: un `cipher` opaco no sirve
 * para comprobar qué pasó. Los hashes viajan junto al contenido para que quien reciba la respuesta
 * pueda rehacer la verificación por su cuenta.
 *
 * Un documento sin registros responde 404 y no una lista vacía: lo que hay que decir es que esa
 * traza no existe, no insinuar que el documento existió y no hizo nada.
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
