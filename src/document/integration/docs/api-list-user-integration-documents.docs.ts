import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationDocumentsPageResponse,
  IntegrationErrorResponseDto,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import { INVALID_REQUEST_EXAMPLE } from './api-integration-examples.docs';
import {
  DOCUMENTS_PAGE_EXAMPLE,
  SCOPE_DENIED_EXAMPLE,
  USER_NOT_FOUND_EXAMPLE,
} from './api-list-organization-integration-documents.docs';

/**
 * `GET /api/v1/integration/users/:userId/documents` — documentos creados por un miembro.
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
        'Requiere `DOCUMENT.READ_OWN` o `DOCUMENT.READ_ORGANIZATION`. Con `READ_OWN` sólo se puede consultar al usuario que emitió la API key; con `READ_ORGANIZATION`, a cualquier miembro activo de la organización. Misma paginación y filtros que el listado de la organización.',
    }),
    ApiParam({
      name: 'userId',
      format: 'uuid',
      example: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      description: '`users.id` del creador',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.READ_ORGANIZATION', {
      forbiddenNote:
        'Con `DOCUMENT.READ_OWN` basta para el propio usuario de la llave; pedir otro responde `INTEGRATION_SCOPE_DENIED`.',
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
        '`INTEGRATION_USER_NOT_FOUND`: el usuario no es miembro activo de la organización de la llave (o el id no es un UUID)',
      type: IntegrationErrorResponseDto,
      examples: { userNotFound: USER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: algún filtro es inválido (`page`, `limit` mayor que 100, estatus o fechas).',
      type: IntegrationErrorResponseDto,
      examples: { invalidRequest: INVALID_REQUEST_EXAMPLE },
    }),
  );
}
