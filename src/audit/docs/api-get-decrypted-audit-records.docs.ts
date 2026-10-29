import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /audit/decrypted` — listado paginado de registros ya descifrados. */
export function ApiGetDecryptedAuditRecords() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener todos los registros de auditoría descifrados',
    }),
    ApiResponse({
      status: 200,
      description:
        'Lista paginada de registros descifrados con sus campos de integridad',
    }),
  );
}
