import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { LinkDocumentCollaboratorDto } from '../dto/link-document-collaborator.dto';

/**
 * `PATCH /document/:id/link-collaborator` — vincula la cuenta autenticada a una invitación.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiLinkDocumentCollaborator()
 * ```
 */
export function ApiLinkDocumentCollaborator() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Vincula al usuario autenticado como firmante del documento si fue invitado por email. ' +
        'Con `collaboratorId` vincula esa invitación y responde un `outcome` explícito; el correo ' +
        'que se compara es siempre el verificado de la cuenta, nunca uno del cliente.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiBody({ type: LinkDocumentCollaboratorDto, required: false }),
    ApiResponse({
      status: 200,
      description:
        "Sin collaboratorId: { linked }. Con collaboratorId: { linked, outcome: 'LINKED' | 'ALREADY_LINKED' | 'ACCOUNT_MISMATCH' | 'NOT_AVAILABLE' }; sólo LINKED y ALREADY_LINKED traen linked=true",
    }),
    ApiResponse({
      status: 404,
      description:
        'Con collaboratorId: el documento no existe o ese colaborador no es firmante de él',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
