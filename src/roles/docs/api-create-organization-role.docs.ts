import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { RoleResponse } from '../interfaces/response/role-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations/:organizationId/roles` — alta de un rol propio de la organización. */
export function ApiCreateOrganizationRole() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear un rol personalizado en una organización',
      description:
        'Solo un ADMIN activo de esa organización puede hacerlo. El nombre debe ser único dentro de la organización y distinto de los roles de sistema (ADMIN/MEMBER). Los permisos sólo pueden venir del catálogo estático.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiResponse({
      status: 201,
      description: 'Rol creado correctamente',
      type: RoleResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Los datos enviados son inválidos o incompletos',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
    ApiResponse({
      status: 409,
      description: 'Ya existe un rol con ese nombre en la organización',
    }),
  );
}
