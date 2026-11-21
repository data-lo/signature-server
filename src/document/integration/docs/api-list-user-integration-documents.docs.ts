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
      summary: 'Listar los documentos que creó un miembro',
      description: [
        'Devuelve una página con los documentos que creó el miembro de tu organización con ese `email`. Acepta la misma paginación y los mismos filtros que `GET /api/v1/integration/documents`.',
        '**Permiso:** `DOCUMENT.READ` con alcance `ORGANIZATION`, o `OWN` si `email` es el de quien emitió la llave.',
        'Sustituye a `GET /users/{userId}/documents`, que ahora responde `410 INTEGRATION_ENDPOINT_RETIRED`.',
      ].join('\n\n'),
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        '`INTEGRATION_SCOPE_DENIED`: la llave tiene alcance `OWN` y `email` no es el de quien la emitió.',
      forbiddenExamples: { scopeDenied: SCOPE_DENIED_EXAMPLE },
    }),
    ApiResponse({
      status: 200,
      description: 'Página de documentos y datos de paginación.',
      type: IntegrationDocumentsPageResponse,
      example: {
        ...DOCUMENTS_PAGE_EXAMPLE,
        message: 'Documentos del usuario obtenidos correctamente',
      },
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_USER_NOT_FOUND`: `email` no es de un miembro activo de la organización. Revisa el correo.',
      type: IntegrationErrorResponseDto,
      examples: { userNotFound: USER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_AMBIGUOUS_USER`: `email` corresponde a más de un miembro de la organización. Pide a un administrador que corrija los correos duplicados.',
      type: IntegrationErrorResponseDto,
      examples: { ambiguousUser: AMBIGUOUS_USER_EXAMPLE },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: falta `email`, no es un correo válido o algún filtro no es válido. `details.errors` lista cada problema.',
      type: IntegrationErrorResponseDto,
      examples: { invalidRequest: INVALID_REQUEST_EXAMPLE },
    }),
  );
}
