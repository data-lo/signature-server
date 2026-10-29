import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { OrganizationProfileResponse } from '../interfaces/response/organization-response';

/** `GET /api/v1/organizations/:organizationId` — el perfil de una organización. */
export function ApiGetOrganization() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener el perfil de una organización',
      description:
        'Razón social, nombre de visualización, RFC, teléfono, domicilio y dominio permitido. Es la lectura que faltaba para los campos que PATCH /account/:id ya sabía escribir. Solo un miembro con permiso ORGANIZATION:READ puede consultarlo.',
    }),
    ApiParam({
      name: 'organizationId',
      description: 'UUID de la organización',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Organización obtenida correctamente',
      type: OrganizationProfileResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'El usuario autenticado no es miembro activo de esta organización o su rol no tiene ORGANIZATION:READ',
    }),
    ApiResponse({ status: 404, description: 'La organización no existe' }),
  );
}
