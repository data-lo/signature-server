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

/** 409 de un correo que corresponde a más de un miembro de la organización. */
export const AMBIGUOUS_USER_EXAMPLE = integrationErrorExample(
  'Correo de más de un usuario',
  'INTEGRATION_AMBIGUOUS_USER',
  'El correo corresponde a más de un usuario de la organización',
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
      description: [
        'Devuelve una página con el estado de los documentos de tu organización; por omisión, los más recientes primero. Filtra por `statuses` y por fechas de creación o de firma; con `creatorEmail`, sólo los que creó ese miembro.',
        'Cada documento trae su `id`, nombre de archivo, estado, tipo de firma y fechas; no incluye el PDF ni los participantes.',
        '**Permiso:** `DOCUMENT.READ` con alcance `ORGANIZATION`. Con alcance `OWN` sólo puedes pedir tus propios documentos, enviando tu correo en `creatorEmail`.',
      ].join('\n\n'),
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        '`INTEGRATION_SCOPE_DENIED`: la llave tiene alcance `OWN` y `creatorEmail` no es el de quien la emitió.',
      forbiddenExamples: { scopeDenied: SCOPE_DENIED_EXAMPLE },
    }),
    ApiResponse({
      status: 200,
      description: 'Página de documentos y datos de paginación.',
      type: IntegrationDocumentsPageResponse,
      example: DOCUMENTS_PAGE_EXAMPLE,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: `creatorEmail` no es de un miembro activo de la organización. Revisa el correo.',
      type: IntegrationErrorResponseDto,
      examples: { userNotFound: USER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_AMBIGUOUS_USER`: `creatorEmail` corresponde a más de un miembro de la organización. Pide a un administrador que corrija los correos duplicados.',
      type: IntegrationErrorResponseDto,
      examples: { ambiguousUser: AMBIGUOUS_USER_EXAMPLE },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: algún parámetro no es válido, por ejemplo `limit` mayor que 100, un estado que no existe o una fecha que no es ISO 8601. `details.errors` lista cada problema.',
      type: IntegrationErrorResponseDto,
      examples: { invalidRequest: INVALID_REQUEST_EXAMPLE },
    }),
  );
}
