import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/**
 * `GET /public/documents/:documentId/invitation`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetPublicSigningInvitation()
 * ```
 */
export function ApiGetPublicSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Valida la invitación de un firmante y devuelve lo que la pantalla pública necesita para ' +
        'decidir: nombre del documento, correo invitado enmascarado, tipo de firma, si sigue ' +
        'disponible para firmar y si admite continuar sin cuenta.',
    }),
    ApiParam({
      name: 'documentId',
      description: 'UUID del documento',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description:
        '{ documentName, maskedEmail, signatureType, availableForSigning, guestSigningAllowed }',
    }),
    ApiResponse({
      status: 400,
      description: 'Parámetros con formato inválido',
    }),
    ApiResponse({
      status: 404,
      description:
        'No existe un firmante con esa referencia en el documento (un solo mensaje para todos los casos)',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}
