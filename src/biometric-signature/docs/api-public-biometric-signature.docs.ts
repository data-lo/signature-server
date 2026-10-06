import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { StartBiometricSignatureDto } from '../dto/start-biometric-signature.dto';
import {
  GuestInvitationDto,
  VerifyGuestAccessCodeDto,
} from '../dto/guest-invitation.dto';
import { GUEST_ACCESS_TOKEN_HEADER } from '../guest/guest-access.guard';

const DOCUMENT_PARAM = ApiParam({
  name: 'documentId',
  description: 'UUID del documento',
  format: 'uuid',
});

const GUEST_TOKEN_HEADER = ApiHeader({
  name: GUEST_ACCESS_TOKEN_HEADER,
  required: true,
  description: 'Token de acceso de invitado obtenido en access-code/verify',
});

const INVALID_TOKEN = ApiResponse({
  status: 401,
  description: 'Token de invitado ausente, vencido o de otro documento',
});

/**
 * `GET /public/documents/:documentId/biometric-signature/invitation`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiCheckGuestInvitation()
 * ```
 */
export function ApiCheckGuestInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Indica si la invitación (colaborador + correo del enlace) admite firma biométrica sin ' +
        'cuenta. No dice por qué no.',
    }),
    DOCUMENT_PARAM,
    ApiResponse({ status: 200, description: '{ guestBiometric: boolean }' }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `POST /public/documents/:documentId/biometric-signature/access-code`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiRequestGuestAccessCode()
 * ```
 */
export function ApiRequestGuestAccessCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Envía un código de acceso al correo GUARDADO de la invitación (no al de la petición).',
    }),
    DOCUMENT_PARAM,
    ApiBody({ type: GuestInvitationDto }),
    ApiResponse({ status: 200, description: '{ emailDelivered: boolean }' }),
    ApiResponse({
      status: 403,
      description: 'La invitación no admite firma de invitado',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas solicitudes' }),
  );
}

/**
 * `POST /public/documents/:documentId/biometric-signature/access-code/verify`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiVerifyGuestAccessCode()
 * ```
 */
export function ApiVerifyGuestAccessCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Canjea el código por un token de acceso de invitado (30 min), atado a documento, ' +
        'colaborador y correo.',
    }),
    DOCUMENT_PARAM,
    ApiBody({ type: VerifyGuestAccessCodeDto }),
    ApiResponse({ status: 200, description: '{ accessToken, expiresAt }' }),
    ApiResponse({
      status: 400,
      description: 'Código inexistente, vencido o incorrecto',
    }),
    ApiResponse({
      status: 403,
      description: 'La invitación no admite firma de invitado',
    }),
    ApiResponse({ status: 429, description: 'Demasiados intentos' }),
  );
}

/**
 * `GET /public/documents/:documentId/biometric-signature/document`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetGuestSigningDocument()
 * ```
 */
export function ApiGetGuestSigningDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Documento que se le pide firmar al invitado: nombre, estado, si puede firmar y URL ' +
        'prefirmada del PDF.',
    }),
    DOCUMENT_PARAM,
    GUEST_TOKEN_HEADER,
    ApiResponse({ status: 200, description: 'Datos del documento' }),
    INVALID_TOKEN,
  );
}

/**
 * `POST /public/documents/:documentId/biometric-signature/session`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiStartGuestBiometricSession()
 * ```
 */
export function ApiStartGuestBiometricSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Iniciar la firma biométrica del invitado (KYC de Didit: identificación + prueba de vida ' +
        '+ face match). Reutiliza la sesión abierta si sirve. No firma: la firma se registra ' +
        'cuando Didit aprueba por webhook.',
    }),
    DOCUMENT_PARAM,
    GUEST_TOKEN_HEADER,
    ApiBody({ type: StartBiometricSignatureDto }),
    ApiResponse({ status: 201, description: 'Sesión lista' }),
    ApiResponse({
      status: 400,
      description:
        'Falta la ubicación o el consentimiento, el documento no está pendiente o ya respondiste',
    }),
    INVALID_TOKEN,
    ApiResponse({ status: 403, description: 'No es tu turno' }),
    ApiResponse({ status: 502, description: 'Didit no pudo crear la sesión' }),
  );
}

/**
 * `GET /public/documents/:documentId/biometric-signature/session`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetGuestBiometricSession()
 * ```
 */
export function ApiGetGuestBiometricSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Estado del último intento biométrico del invitado. Nunca incluye el veredicto.',
    }),
    DOCUMENT_PARAM,
    GUEST_TOKEN_HEADER,
    ApiResponse({ status: 200, description: 'Estado del último intento' }),
    INVALID_TOKEN,
  );
}
