import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import { OrganizationApiKeyResponse } from '../interfaces/response/organization-api-key-response';
import { ApiOrganizationApiKeyCommonResponses } from './api-organization-api-key-errors.docs';

/** `GET /api/v1/organizations/:organizationId/api-keys/current` — llave vigente. */
export function ApiGetCurrentOrganizationApiKey() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar la API key vigente de la organización',
      description:
        'Requiere `API_KEY.MANAGE`. Devuelve la llave `ACTIVE` con su prefijo, permisos, creación, último uso y expiración, sin el secreto. Una llave activa vencida se devuelve igual, con su `expiresAt`.',
    }),
    ApiOrganizationApiKeyCommonResponses(
      '`API_KEY_NOT_FOUND`: la organización no tiene una llave activa',
    ),
    ApiResponse({
      status: 200,
      description: 'API key vigente',
      type: OrganizationApiKeyResponse,
    }),
  );
}
