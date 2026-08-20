import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

/** `DELETE /api/v1/organizations/:organizationId/permissions/:permissionId`. */
export function ApiDeleteOrganizationPermission() {
  return applyDecorators(
    ApiOperation({
      summary: 'Eliminar un permiso del catálogo',
      description:
        'Solo un ADMIN activo de esa organización puede hacerlo. Elimina también la asignación del permiso en cualquier miembro que lo tuviera.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiParam({ name: 'permissionId', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Permiso eliminado correctamente',
      type: BaseResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
    ApiResponse({ status: 404, description: 'Permiso no encontrado' }),
  );
}
