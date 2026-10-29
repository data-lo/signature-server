import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { RoleResponse } from '../interfaces/response/role-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /api/v1/organizations/:organizationId/roles/:roleId` — edita un rol propio. */
export function ApiUpdateOrganizationRole() {
  return applyDecorators(
    ApiOperation({
      summary: 'Editar el nombre y/o los permisos de un rol personalizado',
      description:
        'Solo un ADMIN activo de esa organización puede hacerlo. Los roles de sistema (ADMIN/MEMBER) o de otra organización responden 404. Los permisos enviados reemplazan el set completo del rol.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiParam({ name: 'roleId', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Rol actualizado correctamente',
      type: RoleResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Los datos enviados son inválidos',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
    ApiResponse({
      status: 404,
      description:
        'El rol no existe, es de otra organización, o es un rol de sistema (no editable)',
    }),
    ApiResponse({
      status: 409,
      description: 'Ya existe otro rol con ese nombre en la organización',
    }),
  );
}
