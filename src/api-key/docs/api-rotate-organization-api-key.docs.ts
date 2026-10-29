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

/** `POST /api/v1/organizations/:organizationId/api-keys/rotate` — rotación de la llave vigente. */
export function ApiRotateOrganizationApiKey() {
  return applyDecorators(
    ApiOperation({
      summary: 'Rotar la API key de la organización',
      description:
        'Requiere `API_KEY.MANAGE`. En una sola transacción revoca la llave activa (que se conserva como `REVOKED`) y emite otra. El body es opcional: el nombre y los permisos omitidos se heredan de la llave vigente; `expiresAt` no se hereda. La llave nueva completa (`data.key`) sólo se devuelve en esta respuesta.',
    }),
    ApiOrganizationApiKeyCommonResponses(
      '`API_KEY_NOT_FOUND`: no hay una llave activa que rotar',
    ),
    ApiResponse({
      status: 201,
      description: 'API key rotada',
      type: IssuedOrganizationApiKeyResponse,
    }),
    ApiResponse({
      status: 409,
      description:
        '`API_KEY_ROTATION_CONFLICT`: otra rotación o alta de la misma organización está en curso',
      type: OrganizationApiKeyErrorResponse,
    }),
    ApiOrganizationApiKeyUnprocessableResponse(),
  );
}
