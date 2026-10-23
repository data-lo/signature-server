import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import {
  GuestAdvancedInvitationDto,
  VerifyGuestAdvancedAccessCodeDto,
} from '../dto/guest-advanced-invitation.dto';
import { GUEST_SIGNING_TOKEN_HEADER } from '../guest/guest-signing-access.guard';

const DOCUMENT_PARAM = ApiParam({
  name: 'documentId',
  description: 'UUID del documento',
  format: 'uuid',
});

const GUEST_TOKEN_HEADER = ApiHeader({
  name: GUEST_SIGNING_TOKEN_HEADER,
  required: true,
  description: 'Token de acceso de invitado obtenido en access-code/verify',
});

const INVALID_ACCESS = ApiResponse({
  status: 401,
  description:
    'Token ausente o vencido, o su acceso fue revocado, ya se consumió o es de otro documento',
});

/**
 * `GET /public/documents/:documentId/advanced-signature/invitation`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiCheckGuestAdvancedInvitation()
 * ```
 */
export function ApiCheckGuestAdvancedInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Indica si la invitación (colaborador y, si viene, correo del enlace) admite Firma ' +
        'Avanzada sin cuenta. No dice por qué no.',
    }),
    DOCUMENT_PARAM,
    ApiResponse({
      status: 200,
      description: '{ guestAdvancedSignature: boolean }',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `POST /public/documents/:documentId/advanced-signature/access-code`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiRequestGuestAdvancedAccessCode()
 * ```
 */
export function ApiRequestGuestAdvancedAccessCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Envía un código GUEST_ADVANCED_SIGNATURE_ACCESS al correo GUARDADO de la invitación, si ' +
        'el documento está pendiente y es el turno del invitado.',
    }),
    DOCUMENT_PARAM,
    ApiBody({ type: GuestAdvancedInvitationDto }),
    ApiResponse({ status: 200, description: '{ emailDelivered: boolean }' }),
    ApiResponse({
      status: 400,
      description: 'El documento no está pendiente o el invitado ya respondió',
    }),
    ApiResponse({
      status: 403,
      description:
        'La invitación no admite firma de invitado, o todavía no es su turno',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas solicitudes' }),
  );
}

/**
 * `POST /public/documents/:documentId/advanced-signature/access-code/verify`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiVerifyGuestAdvancedAccessCode()
 * ```
 */
export function ApiVerifyGuestAdvancedAccessCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Canjea el código por un acceso temporal (30 min). Revoca los accesos anteriores del ' +
        'mismo invitado.',
    }),
    DOCUMENT_PARAM,
    ApiBody({ type: VerifyGuestAdvancedAccessCodeDto }),
    ApiResponse({
      status: 200,
      description: '{ accessToken: string, expiresAt: string }',
    }),
    ApiResponse({
      status: 400,
      description: 'Código inexistente, vencido, incorrecto o ya usado',
    }),
    ApiResponse({
      status: 403,
      description: 'La invitación no admite firma de invitado',
    }),
    ApiResponse({
      status: 409,
      description: 'Otra validación simultánea emitió un acceso primero',
    }),
    ApiResponse({ status: 429, description: 'Demasiados intentos' }),
  );
}

/**
 * `GET /public/documents/:documentId/advanced-signature/document`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetGuestAdvancedSigningDocument()
 * ```
 */
export function ApiGetGuestAdvancedSigningDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Documento que se le pide firmar al invitado: estado, si puede firmar, hash vigente y URL ' +
        'prefirmada del PDF.',
    }),
    DOCUMENT_PARAM,
    GUEST_TOKEN_HEADER,
    ApiResponse({ status: 200, description: 'Vista del documento' }),
    INVALID_ACCESS,
    ApiResponse({
      status: 403,
      description: 'La invitación ya no admite firma de invitado',
    }),
  );
}

/**
 * `POST /public/documents/:documentId/advanced-signature/sign`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiSignGuestAdvancedDocument()
 * ```
 */
export function ApiSignGuestAdvancedDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Firma con e.firma (FIEL) como invitado sin cuenta. Consume el acceso; la llave, la ' +
        'contraseña y el token no se guardan.',
    }),
    DOCUMENT_PARAM,
    GUEST_TOKEN_HEADER,
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['key', 'cer', 'password', 'geolocation', 'documentHash'],
        properties: {
          key: { type: 'string', format: 'binary' },
          cer: { type: 'string', format: 'binary' },
          password: { type: 'string' },
          geolocation: {
            type: 'string',
            example: '{"latitude":19.43,"longitude":-99.13}',
          },
          documentHash: { type: 'string' },
        },
      },
    }),
    ApiResponse({ status: 200, description: 'Firma registrada' }),
    ApiResponse({
      status: 400,
      description:
        'Falta geolocalización o e.firma, el documento cambió o no está pendiente, o el invitado ya respondió',
    }),
    INVALID_ACCESS,
    ApiResponse({
      status: 403,
      description:
        'La invitación ya no admite firma de invitado, o no es su turno',
    }),
    ApiResponse({
      status: 422,
      description: 'La e.firma no es válida (contraseña, vigencia, cadena SAT)',
    }),
  );
}
