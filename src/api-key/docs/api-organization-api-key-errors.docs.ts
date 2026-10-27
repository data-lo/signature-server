import { applyDecorators } from '@nestjs/common';
import { ApiParam, ApiResponse } from '@nestjs/swagger';

import { OrganizationApiKeyErrorResponse } from '../interfaces/response/organization-api-key-response';

/**
 * Lo que comparten los cinco endpoints de API keys: el parámetro `organizationId` y las
 * respuestas 401, 403 y 404.
 *
 * El 403 cubre también la organización inexistente: `PermissionsGuard` busca la membresía antes
 * que nada y responde lo mismo a "no eres miembro" que a "no existe", para no revelar qué
 * organizaciones hay. El 404 de organización queda para una que existe pero está desactivada.
 *
 * @param notFoundDescription - Qué otra cosa puede no encontrarse en este endpoint.
 * @returns Los decoradores de Swagger.
 *
 * @example
 * ```ts
 * ApiOrganizationApiKeyCommonResponses('No hay una API key activa');
 * ```
 */
export function ApiOrganizationApiKeyCommonResponses(
  notFoundDescription?: string,
) {
  return applyDecorators(
    ApiParam({ name: 'organizationId', format: 'uuid' }),
    ApiResponse({ status: 401, description: 'JWT ausente o inválido' }),
    ApiResponse({
      status: 403,
      description:
        'Sin membresía activa en la organización (o la organización no existe), o sin `API_KEY.MANAGE`',
    }),
    ApiResponse({
      status: 404,
      description: [
        '`ORGANIZATION_NOT_FOUND`: la organización está desactivada',
        notFoundDescription,
      ]
        .filter(Boolean)
        .join('. '),
      type: OrganizationApiKeyErrorResponse,
    }),
  );
}

/**
 * Las respuestas 422 de los endpoints que reciben body.
 *
 * @returns Los decoradores de Swagger.
 *
 * @example
 * ```ts
 * ApiOrganizationApiKeyUnprocessableResponse();
 * ```
 */
export function ApiOrganizationApiKeyUnprocessableResponse() {
  return ApiResponse({
    status: 422,
    description:
      '`API_KEY_INVALID_BODY` (body inválido), `API_KEY_PERMISSION_NOT_FOUND`, `API_KEY_PERMISSION_NOT_ALLOWED` o `API_KEY_INVALID_EXPIRATION`',
    type: OrganizationApiKeyErrorResponse,
  });
}
