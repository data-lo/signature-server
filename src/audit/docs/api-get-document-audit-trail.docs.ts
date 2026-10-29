import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/** `GET /audit/document/:documentId` — cadena de auditoría descifrada de un documento. */
export function ApiGetDocumentAuditTrail() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener registros de auditoría de un documento descifrados',
    }),
    ApiParam({
      name: 'documentId',
      description: 'UUID del documento',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description:
        'Lista de registros de auditoría descifrados, ordenados por chainIndex ASC',
    }),
    ApiResponse({
      status: 404,
      description: 'No se encontraron registros para el documento',
    }),
  );
}
