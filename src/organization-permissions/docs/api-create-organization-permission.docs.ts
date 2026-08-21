import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { OrganizationPermissionResponse } from '../interfaces/response/organization-permission-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations/:organizationId/permissions` — alta en el catálogo. */
export function ApiCreateOrganizationPermission() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear un permiso en el catálogo de la organización',
      description:
        'Solo un ADMIN activo de esa organización puede hacerlo. El nombre debe ser único dentro de la organización.',
    }),
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiResponse({
      status: 201,
      description: 'Permiso creado correctamente',
      type: OrganizationPermissionResponse,
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
  );
}
