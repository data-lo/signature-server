import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/**
 * `GET /public/documents/:documentId/signing-method`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetPublicSigningMethod()
 * ```
 */
export function ApiGetPublicSigningMethod() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Tipo de firma que el invitado sin cuenta completa en la pantalla pública (BIOMETRIC o ' +
        'FIEL). `null` si la invitación no se firma ahí; no dice por qué.',
    }),
    ApiParam({
      name: 'documentId',
      description: 'UUID del documento',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: "{ signatureType: 'BIOMETRIC' | 'FIEL' | null }",
    }),
    ApiResponse({
      status: 400,
      description: 'Parámetros con formato inválido',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}
