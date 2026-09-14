import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { RoleListResponse } from '../interfaces/response/role-response';

/** `GET /api/v1/organizations/:organizationId/roles` — roles visibles para la organización. */
export function ApiListOrganizationRoles() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar los roles de una organización',
      description:
        'Solo un ADMIN activo de esa organización puede consultarlos. Incluye los roles de sistema (ADMIN/MEMBER) y los propios de la organización.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Roles obtenidos correctamente',
      type: RoleListResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
  );
}
