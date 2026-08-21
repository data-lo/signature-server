import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/** `PATCH /document/:id/link-collaborator` — vincula la cuenta a una invitación por email. */
export function ApiLinkDocumentCollaborator() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Vincula al usuario autenticado como firmante del documento si fue invitado solo por email (Firma Digital Simple) — ver historia "Notificación por Email para Firma Simple y Vinculación de Cuenta"',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description:
        'Vinculación procesada (linked=true si había una invitación pendiente que coincidía con el email del usuario autenticado, linked=false si no)',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
