import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { OrganizationPermissionListResponse } from '../interfaces/response/organization-permission-response';

/** `GET /api/v1/organizations/:organizationId/permissions` — catálogo de permisos. */
export function ApiGetOrganizationPermissions() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar el catálogo de permisos de una organización',
      description: 'Solo un ADMIN activo de esa organización puede listarlos.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Permisos obtenidos correctamente',
      type: OrganizationPermissionListResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
  );
}
