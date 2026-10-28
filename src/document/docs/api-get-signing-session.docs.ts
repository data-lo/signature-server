import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/**
 * `GET /public/signing-sessions/:token`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetSigningSession()
 * ```
 */
export function ApiGetSigningSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Resuelve la invitación individual de un firmante (pantalla pública /sign/:token). Con ' +
        'estado ACTIVE devuelve documento (id y nombre), firmante (colaborador, correo enmascarado, ' +
        'estado de su cuenta y si admite firmar sin cuenta), tipo de firma con sus validaciones, ' +
        'posiciones de firma y vencimiento. Con EXPIRED, REVOKED, ALREADY_SIGNED, ' +
        'DOCUMENT_CANCELLED o UNAVAILABLE devuelve sólo el estado. No da acceso al PDF.',
    }),
    ApiParam({
      name: 'token',
      description: 'Token opaco de la invitación (43 caracteres base64url)',
    }),
    ApiResponse({
      status: 200,
      description:
        '{ status, document?, signer?, signature?, positions?, expiresAt? } (sólo `status` si no está ACTIVE)',
    }),
    ApiResponse({
      status: 404,
      description:
        'El token no existe o no tiene el formato esperado (un solo mensaje para todos los casos)',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}
