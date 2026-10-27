import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import {
  IssuedOrganizationApiKeyResponse,
  OrganizationApiKeyErrorResponse,
} from '../interfaces/response/organization-api-key-response';
import {
  ApiOrganizationApiKeyCommonResponses,
  ApiOrganizationApiKeyUnprocessableResponse,
} from './api-organization-api-key-errors.docs';

/** `POST /api/v1/organizations/:organizationId/api-keys` — emisión de la API key. */
export function ApiCreateOrganizationApiKey() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear la API key de la organización',
      description:
        'Requiere `API_KEY.MANAGE`. Emite una llave `ACTIVE` si la organización no tiene otra. La llave completa (`data.key`) sólo se devuelve en esta respuesta; después sólo se ve su prefijo.',
    }),
    ApiOrganizationApiKeyCommonResponses(),
    ApiResponse({
      status: 201,
      description: 'API key creada',
      type: IssuedOrganizationApiKeyResponse,
    }),
    ApiResponse({
      status: 409,
      description:
        '`API_KEY_ALREADY_ACTIVE`: la organización ya tiene una llave activa',
      type: OrganizationApiKeyErrorResponse,
    }),
    ApiOrganizationApiKeyUnprocessableResponse(),
  );
}
