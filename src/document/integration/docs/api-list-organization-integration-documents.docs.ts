import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationDocumentsPageResponse,
  IntegrationErrorResponseDto,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import {
  INVALID_REQUEST_EXAMPLE,
  integrationErrorExample,
} from './api-integration-examples.docs';

/** Ejemplo de una página de documentos, compartido por los dos listados. */
export const DOCUMENTS_PAGE_EXAMPLE = {
  success: true,
  message: 'Documentos obtenidos correctamente',
  data: {
    items: [
      {
        id: '7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
        fileName: 'contrato.pdf',
        status: 'PENDING_SIGNATURE',
        signatureType: 'SIMPLE',
        createdAt: '2026-10-26T12:00:00.000Z',
        signedAt: null,
      },
    ],
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  },
};

/** 403 cuando la llave no puede consultar el recurso solicitado. */
export const SCOPE_DENIED_EXAMPLE = integrationErrorExample(
  'Alcance insuficiente',
  'INTEGRATION_SCOPE_DENIED',
  'La API key sólo puede consultar los documentos de su propio usuario',
);

/** 404 de un creador que no es miembro activo de la organización de la llave. */
export const USER_NOT_FOUND_EXAMPLE = integrationErrorExample(
  'Usuario fuera de la organización',
  'INTEGRATION_USER_NOT_FOUND',
  'El usuario no existe en la organización',
);

/**
 * `GET /api/v1/integration/documents` — documentos de la organización de la llave, o de un creador
 * con `?creatorEmail=`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiListOrganizationIntegrationDocuments()
 * ```
 */
export function ApiListOrganizationIntegrationDocuments() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar los documentos de la organización',
      description:
        'Devuelve una página (de 1 a 100, 25 por omisión) de documentos de la organización de la API key. Con `creatorEmail`, devuelve sólo los documentos creados por ese miembro. Filtrable por estatus y fechas. No incluye la URL del archivo ni datos de colaboradores.',
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        'También puede devolver `INTEGRATION_SCOPE_DENIED` si la llave no tiene acceso a los documentos solicitados.',
      forbiddenExamples: { scopeDenied: SCOPE_DENIED_EXAMPLE },
    }),
    ApiResponse({
      status: 200,
      description: 'Página de documentos',
      type: IntegrationDocumentsPageResponse,
      example: DOCUMENTS_PAGE_EXAMPLE,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: `creatorEmail` no es de un miembro activo de la organización',
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
