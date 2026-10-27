import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import { IntegrationDocumentsPageResponse } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/** `GET /api/v1/integration/documents` — documentos de la organización de la llave. */
export function ApiListOrganizationIntegrationDocuments() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar los documentos de la organización',
      description:
        'Requiere `DOCUMENT.READ_ORGANIZATION`. Devuelve una página (de 1 a 100, 25 por omisión) de los documentos de la organización de la API key, filtrable por estatus y fechas. Sin URL del archivo ni datos de colaboradores.',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.READ_ORGANIZATION'),
    ApiResponse({
      status: 200,
      description: 'Página de documentos',
      type: IntegrationDocumentsPageResponse,
    }),
  );
}
