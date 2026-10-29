import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { MemberPermissionsResponse } from 'src/organization-permissions/interfaces/response/organization-permission-response';

/** `GET /api/v1/organizations/members/:accountId/permissions` — permisos vigentes del miembro. */
export function ApiGetMemberPermissions() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener los permisos actualmente asignados a un miembro',
      description:
        'Solo un ADMIN activo de esa organización puede consultarlo.',
    }),
    ApiParam({
      name: 'accountId',
      description: 'UUID de la membresía (accountId) a consultar',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Permisos del miembro obtenidos correctamente',
      type: MemberPermissionsResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
  );
}
