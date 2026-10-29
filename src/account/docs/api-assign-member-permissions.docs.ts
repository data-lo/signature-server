import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { MemberPermissionsResponse } from 'src/organization-permissions/interfaces/response/organization-permission-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /api/v1/organizations/members/:accountId/permissions` — reemplazo de la lista. */
export function ApiAssignMemberPermissions() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar la lista de permisos asignados a un miembro',
      description:
        'Reemplaza por completo la lista de permisos asignados. Solo un ADMIN activo de esa organización puede hacerlo.',
    }),
    ApiParam({
      name: 'accountId',
      description: 'UUID de la membresía (accountId) a actualizar',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Permisos del miembro actualizados correctamente',
      type: MemberPermissionsResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Uno o más permisos no pertenecen al catálogo de esta organización',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
  );
}
