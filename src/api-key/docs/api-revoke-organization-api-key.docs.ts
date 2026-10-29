import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { OrganizationApiKeyResponse } from '../interfaces/response/organization-api-key-response';
import { ApiOrganizationApiKeyCommonResponses } from './api-organization-api-key-errors.docs';

/** `DELETE /api/v1/organizations/:organizationId/api-keys/:apiKeyId` — revocación. */
export function ApiRevokeOrganizationApiKey() {
  return applyDecorators(
    ApiOperation({
      summary: 'Revocar una API key de la organización',
      description:
        'Requiere `API_KEY.MANAGE`. Revocación lógica: la llave pasa a `REVOKED` con quién y cuándo, y se conserva en el historial. Es idempotente: revocar una llave ya revocada responde 200 sin cambiarla.',
    }),
    ApiParam({ name: 'apiKeyId', format: 'uuid' }),
    ApiOrganizationApiKeyCommonResponses(
      '`API_KEY_NOT_FOUND`: la llave no existe o es de otra organización',
    ),
    ApiResponse({
      status: 200,
      description: 'API key revocada',
      type: OrganizationApiKeyResponse,
    }),
  );
}
