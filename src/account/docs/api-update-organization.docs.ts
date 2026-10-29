import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { OrganizationProfileResponse } from '../interfaces/response/organization-response';

/** `PATCH /api/v1/organizations/:organizationId` — guarda el perfil de una organización. */
export function ApiUpdateOrganization() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar el perfil de una organización',
      description:
        'Guarda nombre de visualización, razón social, RFC, teléfono, domicilio y dominio permitido. Sólo escribe los campos enviados; RFC, teléfono, domicilio y dominio se borran enviándolos en null o vacíos. Responde con el perfil actualizado, igual que GET /organizations/:organizationId. Solo un miembro con permiso ORGANIZATION:UPDATE puede editarlo.',
    }),
    ApiParam({
      name: 'organizationId',
      description: 'UUID de la organización',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Organización actualizada correctamente',
      type: OrganizationProfileResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Algún campo no tiene un formato válido o se intentó dejar vacío un nombre obligatorio',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'El usuario autenticado no es miembro activo de esta organización o su rol no tiene ORGANIZATION:UPDATE',
    }),
    ApiResponse({ status: 404, description: 'La organización no existe' }),
  );
}
