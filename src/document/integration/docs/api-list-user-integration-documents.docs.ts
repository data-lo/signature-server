import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { OrganizationApiKeyErrorResponse } from 'src/api-key/interfaces/response/organization-api-key-response';

import { IntegrationDocumentsPageResponse } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/** `GET /api/v1/integration/users/:userId/documents` — documentos creados por un miembro. */
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
      description: '`users.id` del creador',
    }),
    ApiIntegrationCommonResponses(
      'DOCUMENT.READ_OWN o DOCUMENT.READ_ORGANIZATION; o `INTEGRATION_SCOPE_DENIED`: con READ_OWN se pidió otro usuario',
    ),
    ApiResponse({
      status: 200,
      description: 'Página de documentos del usuario',
      type: IntegrationDocumentsPageResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: el usuario no es miembro activo de la organización de la llave',
      type: OrganizationApiKeyErrorResponse,
    }),
  );
}
