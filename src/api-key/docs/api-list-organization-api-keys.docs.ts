import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import { OrganizationApiKeyListResponse } from '../interfaces/response/organization-api-key-response';
import { ApiOrganizationApiKeyCommonResponses } from './api-organization-api-key-errors.docs';

/** `GET /api/v1/organizations/:organizationId/api-keys` — historial de llaves. */
export function ApiListOrganizationApiKeys() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar el historial de API keys de la organización',
      description:
        'Requiere `API_KEY.MANAGE`. Devuelve la llave activa y las revocadas, de la más nueva a la más vieja. Nunca incluye la llave completa ni su hash.',
    }),
    ApiOrganizationApiKeyCommonResponses(),
    ApiResponse({
      status: 200,
      description: 'Historial de API keys',
      type: OrganizationApiKeyListResponse,
    }),
  );
}
