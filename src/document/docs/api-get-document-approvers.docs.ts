import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/**
 * `GET /api/v1/documents/approvers` — usuarios que pueden aprobar documentos en la organización
 * activa, para configurar "Requiere aprobación" al crear uno.
 */
export function ApiGetDocumentApprovers() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Lista los miembros activos de la organización activa que pueden aprobar documentos (DOCUMENT.APPROVE). Requiere DOCUMENT.CREATE.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa. Debe ser una membresía de organización.',
      required: true,
    }),
    ApiResponse({
      status: 200,
      description:
        'Aprobadores elegibles: userId, email, firstName y lastName de cada uno. No incluye RFC, rol ni permisos.',
    }),
    ApiResponse({
      status: 400,
      description:
        'La cuenta activa es PERSONAL: no hay organización de la que elegir aprobador.',
    }),
    ApiResponse({
      status: 403,
      description:
        'Sin membresía activa en la cuenta, o su rol no tiene DOCUMENT.CREATE.',
    }),
  );
}
