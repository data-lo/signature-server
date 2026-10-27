import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';

import { PUBLIC_SIGNING_SESSION_COOKIE } from '../public-signing-session.cookie';

const TOKEN_PARAM = ApiParam({
  name: 'token',
  description: 'Token opaco de la invitación (43 caracteres base64url)',
});

const INVALID_TOKEN = ApiResponse({
  status: 404,
  description:
    'Token inexistente, vencido, revocado o de un firmante que no puede firmar desde la invitación (un solo mensaje genérico)',
});

const SESSION_COOKIE = ApiCookieAuth(PUBLIC_SIGNING_SESSION_COOKIE);

const INVALID_SESSION = ApiResponse({
  status: 401,
  description:
    'Sin sesión pública, o venció, se consumió o se revocó (mensaje genérico)',
});

const IDEMPOTENCY_KEY = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description:
    '1 a 255 caracteres ASCII visibles. Con la misma clave y la misma petición se devuelve la respuesta original; con otra petición, 422; mientras sigue en curso, 409.',
});

/**
 * `GET /public/signing-invitations/:token`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetSigningInvitation()
 * ```
 */
export function ApiGetSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Valida el token de /sign/:token y devuelve el contexto mínimo, sin el PDF: con ACTIVE, nombre del documento, correo enmascarado, estado de la cuenta, si admite la firma pública, tipo de firma con sus validaciones y vencimiento; con EXPIRED, REVOKED, ALREADY_SIGNED, DOCUMENT_CANCELLED o UNAVAILABLE, sólo el estado.',
    }),
    TOKEN_PARAM,
    ApiResponse({
      status: 200,
      description: '{ status, document?, signer?, signature?, expiresAt? }',
    }),
    ApiResponse({
      status: 404,
      description: 'El token no existe o no tiene formato (mensaje genérico)',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `POST /public/signing-invitations/:token/otp`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiRequestSigningInvitationCode()
 * ```
 */
export function ApiRequestSigningInvitationCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Envía un código de 6 dígitos al correo guardado del firmante de la invitación. Uno por minuto y cinco por hora por invitación.',
    }),
    TOKEN_PARAM,
    ApiResponse({
      status: 200,
      description: '{ maskedEmail, emailDelivered, resendAfterSeconds }',
    }),
    INVALID_TOKEN,
    ApiResponse({ status: 429, description: 'Demasiados códigos pedidos' }),
  );
}

/**
 * `POST /public/signing-invitations/:token/otp/verify`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiVerifySigningInvitationCode()
 * ```
 */
export function ApiVerifySigningInvitationCode() {
  return applyDecorators(
    ApiOperation({
      summary: `Valida el código y abre la sesión pública de firma: la deja en la cookie ${PUBLIC_SIGNING_SESSION_COOKIE} (HttpOnly, Secure, SameSite=Strict, 30 minutos). El token de la sesión nunca va en el cuerpo. Cinco códigos equivocados por invitación cada 15 minutos.`,
    }),
    TOKEN_PARAM,
    ApiResponse({ status: 200, description: '{ expiresAt } + Set-Cookie' }),
    ApiResponse({
      status: 400,
      description: 'No hay código pendiente, venció o no coincide',
    }),
    INVALID_TOKEN,
    ApiResponse({
      status: 409,
      description: 'Otra validación abrió la sesión al mismo tiempo',
    }),
    ApiResponse({
      status: 429,
      description: 'Demasiados códigos equivocados',
    }),
  );
}

/**
 * `POST /public/signing-invitations/:token/renew`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiRenewSigningInvitation()
 * ```
 */
export function ApiRenewSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Si el enlace venció y el documento sigue esperando la firma de este firmante, le envía una invitación nueva a su correo. La respuesta es siempre la misma y nunca incluye el enlace nuevo.',
    }),
    TOKEN_PARAM,
    ApiResponse({ status: 202, description: '{ message } (genérico)' }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `GET /public/signing-sessions/current`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetCurrentSigningSession()
 * ```
 */
export function ApiGetCurrentSigningSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Contexto completo de la sesión pública: documento (nombre, estado, páginas, hash), firmante (correo enmascarado, estado, si puede firmar), tipo de firma con su credencial y posiciones de firma.',
    }),
    SESSION_COOKIE,
    ApiResponse({ status: 200, description: 'CurrentSigningSession' }),
    INVALID_SESSION,
  );
}

/**
 * `GET /public/signing-sessions/current/document`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetCurrentSigningDocument()
 * ```
 */
export function ApiGetCurrentSigningDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'URL temporal prefirmada del PDF de la sesión y su hash. Sólo con sesión (código del correo ya validado).',
    }),
    SESSION_COOKIE,
    ApiResponse({
      status: 200,
      description: '{ fileUrl, expiresIn, documentHash }',
    }),
    INVALID_SESSION,
    ApiResponse({
      status: 404,
      description: 'El documento todavía no sale a firma',
    }),
  );
}

/**
 * `POST /public/signing-sessions/current/simple/verify-identity`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiVerifyPublicSignerIdentity()
 * ```
 */
export function ApiVerifyPublicSignerIdentity() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Abre (o retoma) la verificación de identidad de Didit del usuario provisional, previa a la firma simple. Mismo flujo que el onboarding de la plataforma.',
    }),
    SESSION_COOKIE,
    ApiResponse({
      status: 201,
      description:
        '{ verificationId, provider, status, sessionId, url, expiresAt, reused }',
    }),
    ApiResponse({
      status: 400,
      description: 'El firmante no es de firma simple con usuario provisional',
    }),
    INVALID_SESSION,
  );
}

/**
 * `POST /public/signing-sessions/current/simple/sign`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiSignPublicSimple()
 * ```
 */
export function ApiSignPublicSimple() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Firma simple pública. Multipart: documentHash, geolocation y, si el usuario provisional aún no tiene rúbrica, signatureImage (PNG), que se registra como su firma antes de firmar.',
    }),
    SESSION_COOKIE,
    IDEMPOTENCY_KEY,
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['documentHash', 'geolocation'],
        properties: {
          documentHash: { type: 'string' },
          geolocation: {
            type: 'string',
            example: '{"latitude":19.4,"longitude":-99.1}',
          },
          signatureImage: { type: 'string', format: 'binary' },
        },
      },
    }),
    ApiResponse({
      status: 200,
      description: '{ success, message, data: { id, documentCompleted } }',
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta Idempotency-Key, no es firma simple, falta la rúbrica, el PDF cambió, identidad sin validar o ya respondió',
    }),
    INVALID_SESSION,
    ApiResponse({ status: 409, description: 'La misma clave sigue en curso' }),
    ApiResponse({
      status: 422,
      description: 'La clave se usó con otra petición',
    }),
  );
}

/**
 * `POST /public/signing-sessions/current/advanced/sign`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiSignPublicAdvanced()
 * ```
 */
export function ApiSignPublicAdvanced() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Firma Electrónica Avanzada pública. Multipart: key (.key), cer (.cer), password, documentHash y geolocation.',
    }),
    SESSION_COOKIE,
    IDEMPOTENCY_KEY,
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['key', 'cer', 'password', 'documentHash', 'geolocation'],
        properties: {
          key: { type: 'string', format: 'binary' },
          cer: { type: 'string', format: 'binary' },
          password: { type: 'string' },
          documentHash: { type: 'string' },
          geolocation: {
            type: 'string',
            example: '{"latitude":19.4,"longitude":-99.1}',
          },
        },
      },
    }),
    ApiResponse({
      status: 200,
      description: '{ success, message, data: { id, documentCompleted } }',
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta Idempotency-Key, no es FIEL, el PDF cambió o ya respondió',
    }),
    INVALID_SESSION,
    ApiResponse({ status: 409, description: 'La misma clave sigue en curso' }),
    ApiResponse({
      status: 422,
      description: 'e.firma inválida, o la clave se usó con otra petición',
    }),
  );
}

/**
 * `POST /public/signing-sessions/current/biometric/sign`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiSignPublicBiometric()
 * ```
 */
export function ApiSignPublicBiometric() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Firma biométrica pública: abre (o retoma) la sesión de Didit con consentimiento y ubicación. La firma se registra al llegar el webhook de Didit.',
    }),
    SESSION_COOKIE,
    IDEMPOTENCY_KEY,
    ApiResponse({ status: 200, description: 'BiometricSignatureSession' }),
    ApiResponse({
      status: 400,
      description:
        'Falta Idempotency-Key, no es biométrica o ya no puede iniciarla',
    }),
    INVALID_SESSION,
    ApiResponse({ status: 409, description: 'La misma clave sigue en curso' }),
    ApiResponse({ status: 502, description: 'Didit no respondió' }),
  );
}
