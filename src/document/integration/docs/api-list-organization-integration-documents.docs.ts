import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationDocumentsPageResponse,
  IntegrationErrorResponseDto,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/**
 * `GET /api/v1/integration/documents` — documentos de la organización de la llave, o de un creador
 * con `?creatorEmail=`.
 */
export function ApiListOrganizationIntegrationDocuments() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar los documentos de la organización',
      description:
        'Sin `creatorEmail` requiere `DOCUMENT.READ_ORGANIZATION` y devuelve una página (de 1 a 100, 25 por omisión) de los documentos de la organización de la API key. Con `creatorEmail` devuelve sólo los que creó ese miembro: con `DOCUMENT.READ_OWN`, únicamente el correo del usuario que emitió la llave; con `DOCUMENT.READ_ORGANIZATION`, cualquier miembro activo. Filtrable por estatus y fechas. Sin URL del archivo ni datos de colaboradores.',
    }),
    ApiIntegrationCommonResponses(
      'DOCUMENT.READ_ORGANIZATION (o READ_OWN con creatorEmail propio); o `INTEGRATION_SCOPE_DENIED`: con READ_OWN se pidió la organización u otro creador',
    ),
    ApiResponse({
      status: 200,
      description: 'Página de documentos',
      type: IntegrationDocumentsPageResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: `creatorEmail` no es de un miembro activo de la organización',
      type: IntegrationErrorResponseDto,
    }),
  );
}
