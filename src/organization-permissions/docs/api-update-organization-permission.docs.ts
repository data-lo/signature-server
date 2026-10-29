import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { OrganizationPermissionResponse } from '../interfaces/response/organization-permission-response';

/** `PATCH /api/v1/organizations/:organizationId/permissions/:permissionId` — nombre y/o estatus. */
export function ApiUpdateOrganizationPermission() {
  return applyDecorators(
    ApiOperation({
      summary: 'Modificar un permiso del catálogo (nombre y/o estatus)',
      description: 'Solo un ADMIN activo de esa organización puede hacerlo.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiParam({ name: 'permissionId', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Permiso actualizado correctamente',
      type: OrganizationPermissionResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
    ApiResponse({ status: 404, description: 'Permiso no encontrado' }),
  );
}
