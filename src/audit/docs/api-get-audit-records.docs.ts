import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /audit` — listado paginado de registros tal como están guardados (cifrados). */
export function ApiGetAuditRecords() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener todos los registros de auditoría (cifrados)',
    }),
    ApiResponse({
      status: 200,
      description: 'Lista paginada de registros de auditoría',
    }),
  );
}
