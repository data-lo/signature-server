import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationDocumentsPageResponse,
  IntegrationErrorResponseDto,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import { INVALID_REQUEST_EXAMPLE } from './api-integration-examples.docs';
import {
  AMBIGUOUS_USER_EXAMPLE,
  DOCUMENTS_PAGE_EXAMPLE,
  SCOPE_DENIED_EXAMPLE,
  USER_NOT_FOUND_EXAMPLE,
} from './api-list-organization-integration-documents.docs';

/**
 * `GET /api/v1/integration/users/documents?email=` — documentos creados por un miembro.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiListUserIntegrationDocuments()
 * ```
 */
export function ApiListUserIntegrationDocuments() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Listar los documentos creados por un usuario de la organización',
      description:
        'Devuelve una página de documentos creados por el usuario con ese `email`, obligatorio. Admite la misma paginación y filtros por estatus y fechas que el listado de la organización. Reemplaza a `GET /users/{userId}/documents`, que ahora responde `410 INTEGRATION_ENDPOINT_RETIRED`.',
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        'Puede devolver `INTEGRATION_SCOPE_DENIED` si la llave no tiene acceso a los documentos solicitados.',
      forbiddenExamples: { scopeDenied: SCOPE_DENIED_EXAMPLE },
    }),
    ApiResponse({
      status: 200,
      description: 'Página de documentos del usuario',
      type: IntegrationDocumentsPageResponse,
      example: {
        ...DOCUMENTS_PAGE_EXAMPLE,
        message: 'Documentos del usuario obtenidos correctamente',
      },
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: el correo no es de un miembro activo de la organización de la llave',
      type: IntegrationErrorResponseDto,
      examples: { userNotFound: USER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_AMBIGUOUS_USER`: el correo corresponde a más de un miembro de la organización',
      type: IntegrationErrorResponseDto,
      examples: { ambiguousUser: AMBIGUOUS_USER_EXAMPLE },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: falta `email` o no es un correo válido, o algún filtro es inválido (`page`, `limit` mayor que 100, estatus o fechas).',
      type: IntegrationErrorResponseDto,
      examples: { invalidRequest: INVALID_REQUEST_EXAMPLE },
    }),
  );
}
