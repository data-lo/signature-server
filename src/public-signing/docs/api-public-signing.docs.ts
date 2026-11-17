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

import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  PUBLIC_SIGNING_SESSION_COOKIE,
} from '../public-signing-session.cookie';

const TOKEN_PARAM = ApiParam({
  name: 'token',
  description: 'Token opaco de la invitación (43 caracteres base64url)',
});

const SESSION_COOKIE = ApiCookieAuth(PUBLIC_SIGNING_SESSION_COOKIE);

const INVITATION_COOKIE = ApiCookieAuth(PUBLIC_SIGNING_INVITATION_COOKIE);

const INVALID_INVITATION_ACCESS = ApiResponse({
  status: 401,
  description:
    'Sin cookie de acceso a la invitación, o venció (vuelve a abrir el enlace); mensaje genérico',
});

const INACTIVE_INVITATION = ApiResponse({
  status: 404,
  description:
    'La invitación ya no está activa o el firmante no puede firmar desde ella (mensaje genérico)',
});

const INVITATION_CONTEXT = ApiResponse({
  status: 200,
  description:
    '{ status, document?, signer?, signature?, expiresAt? } (sólo `status` si no está ACTIVE; `WAITING_FOR_PREVIOUS_SIGNER` si todavía no es su turno) + Set-Cookie de acceso si puede seguir',
});

const INVALID_SESSION = ApiResponse({
  status: 401,
  description:
    'Sin sesión pública, o venció, se consumió o se revocó (mensaje genérico)',
});

/** Errores de la sesión: `{ statusCode, error, code, message }` (`PublicSigningErrorFilter`). */
const SIGNING_NOT_AVAILABLE = ApiResponse({
  status: 409,
  description:
    'code SIGNING_NOT_AVAILABLE: el documento ya no espera esta firma o todavía no es su turno',
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
        'Valida el token de /sign/:token y devuelve el contexto mínimo, sin el PDF: con ACTIVE, nombre del documento (y su id sólo si se firma desde una cuenta activa, para volver a él tras el login), correo enmascarado, estado de la cuenta, si admite la firma pública, tipo de firma con sus validaciones y vencimiento; con EXPIRED, REVOKED, ALREADY_SIGNED, DOCUMENT_CANCELLED o UNAVAILABLE, sólo el estado.',
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
 * `POST /public/signing-invitations/current/otp`.
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
        'Envía un código de 6 dígitos al correo guardado del firmante de la invitación de la cookie de acceso (correo o portal del tercero). Uno por minuto y cinco por hora por invitación.',
    }),
    INVITATION_COOKIE,
    ApiResponse({
      status: 200,
      description: '{ maskedEmail, emailDelivered, resendAfterSeconds }',
    }),
    INVALID_INVITATION_ACCESS,
    INACTIVE_INVITATION,
    ApiResponse({ status: 429, description: 'Demasiados códigos pedidos' }),
  );
}

/**
 * `POST /public/signing-invitations/current/otp/verify`.
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
      summary: `Valida el código y abre la sesión pública de firma: la deja en la cookie ${PUBLIC_SIGNING_SESSION_COOKIE} (HttpOnly, Secure, SameSite=Strict, 30 minutos). El token de la sesión nunca va en el cuerpo, y se borra la cookie de acceso a la invitación. Es la misma sesión llegue el firmante por el correo o por el portal del tercero. Cinco códigos equivocados por invitación cada 15 minutos.`,
    }),
    INVITATION_COOKIE,
    ApiResponse({ status: 200, description: '{ expiresAt } + Set-Cookie' }),
    ApiResponse({
      status: 400,
      description: 'No hay código pendiente, venció o no coincide',
    }),
    INVALID_INVITATION_ACCESS,
    INACTIVE_INVITATION,
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
        'Contexto completo de la sesión pública: status (READY_TO_SIGN, SIGNED, SIGNING_NOT_AVAILABLE, IDENTITY_VERIFICATION_REQUIRED, IDENTITY_VERIFICATION_REJECTED, IDENTITY_DATA_MISMATCH), documento (nombre, estado, páginas, hash), firmante (nombre, correo enmascarado, si es provisional, si puede firmar), requisitos de la firma (type SIMPLE|ADVANCED|BIOMETRIC, requiresEmailVerification, requiresIdentityValidation, identityProvider, requiresCertificateValidation, certificateRequirements) con el estado de la identidad, y posiciones de firma.',
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
 * `POST /public/signing-sessions/current/simple/identity-verification/start`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiStartPublicSignerIdentityVerification()
 * ```
 */
export function ApiStartPublicSignerIdentityVerification() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Abre (o retoma) la verificación de identidad de Didit del usuario provisional, previa a la firma simple. Mismo flujo que el onboarding de la plataforma. Cinco inicios por hora por firmante.',
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
    SIGNING_NOT_AVAILABLE,
    ApiResponse({
      status: 429,
      description: 'Demasiadas verificaciones iniciadas',
    }),
  );
}

/**
 * `GET /public/signing-sessions/current/simple/identity-verification`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetPublicSignerIdentityVerification()
 * ```
 */
export function ApiGetPublicSignerIdentityVerification() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Estado de la verificación de identidad del firmante simple contra la política: aprobada, pendiente, en revisión, rechazada o vencida, y si los datos de Didit corresponden al firmante. Para sondear mientras Didit decide.',
    }),
    SESSION_COOKIE,
    ApiResponse({
      status: 200,
      description:
        '{ status: NOT_STARTED|PENDING|IN_PROGRESS|IN_REVIEW|APPROVED|REJECTED|EXPIRED, verificationId, dataMatches, resumeUrl, satisfied, errorCode }',
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
        'Falta Idempotency-Key, no es firma simple, falta la rúbrica o el PDF cambió',
    }),
    ApiResponse({
      status: 403,
      description:
        'code EMAIL_VERIFICATION_REQUIRED, IDENTITY_VERIFICATION_REQUIRED, IDENTITY_VERIFICATION_REJECTED o IDENTITY_DATA_MISMATCH',
    }),
    INVALID_SESSION,
    ApiResponse({
      status: 409,
      description:
        'La misma clave sigue en curso, o code SIGNING_NOT_AVAILABLE (ya respondió o no es su turno)',
    }),
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
      description: 'Falta Idempotency-Key, no es FIEL o el PDF cambió',
    }),
    ApiResponse({
      status: 403,
      description: 'code EMAIL_VERIFICATION_REQUIRED',
    }),
    INVALID_SESSION,
    ApiResponse({
      status: 409,
      description:
        'La misma clave sigue en curso, o code SIGNING_NOT_AVAILABLE (ya respondió o no es su turno)',
    }),
    ApiResponse({
      status: 422,
      description:
        'code CERTIFICATE_INVALID (inválido, vencido, cadena no confiable, llave o contraseña), CERTIFICATE_REVOKED, CERTIFICATE_SUBJECT_MISMATCH (RFC o nombre del titular) o SIGNATURE_VALIDATION_FAILED; o la clave se usó con otra petición',
    }),
    ApiResponse({
      status: 429,
      description: 'Demasiados intentos con certificado',
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

/**
 * `POST /public/signing-invitations/:token/access`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiOpenSigningInvitation()
 * ```
 */
export function ApiOpenSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary: `Canjea el token de la invitación del correo (/sign/:token): devuelve el contexto mínimo, sin el PDF, y si la invitación está activa deja la cookie ${PUBLIC_SIGNING_INVITATION_COOKIE} (HttpOnly, Secure, SameSite=Strict, 30 minutos) para pedir y validar el código. El token no se consume: sirve mientras la invitación viva.`,
    }),
    TOKEN_PARAM,
    INVITATION_CONTEXT,
    ApiResponse({
      status: 404,
      description: 'El token no existe o no tiene formato (mensaje genérico)',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `POST /public/signing-launches/:token/access`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiOpenSigningLaunch()
 * ```
 */
export function ApiOpenSigningLaunch() {
  return applyDecorators(
    ApiOperation({
      summary: `Canjea un acceso temporal del portal del tercero (/sign/launch/:token): lo consume (un solo uso), resuelve la invitación del firmante para el que se pidió y devuelve lo mismo que el canje del correo, con la misma cookie ${PUBLIC_SIGNING_INVITATION_COOKIE}. No autoriza la firma: falta el código del correo.`,
    }),
    ApiParam({
      name: 'token',
      description: 'Token de lanzamiento (`sla_` + 43 caracteres base64url)',
    }),
    INVITATION_CONTEXT,
    ApiResponse({
      status: 404,
      description:
        'El token no existe, venció o ya se usó (un solo mensaje genérico)',
    }),
    ApiResponse({ status: 429, description: 'Demasiadas consultas' }),
  );
}

/**
 * `GET /public/signing-invitations/current`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetCurrentSigningInvitation()
 * ```
 */
export function ApiGetCurrentSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Contexto mínimo de la invitación de la cookie de acceso (para recargar la página antes de validar el código). Sin PDF ni ids.',
    }),
    INVITATION_COOKIE,
    ApiResponse({
      status: 200,
      description: '{ status, document?, signer?, signature?, expiresAt? }',
    }),
    INVALID_INVITATION_ACCESS,
  );
}

/**
 * `GET /public/signing-sessions/current/biometric`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetCurrentBiometricSession()
 * ```
 */
export function ApiGetCurrentBiometricSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Estado del último intento biométrico del firmante de la sesión (para sondear el resultado de Didit). Vacío si nunca inició uno.',
    }),
    SESSION_COOKIE,
    ApiResponse({
      status: 200,
      description: 'BiometricSignatureSession | null',
    }),
    INVALID_SESSION,
  );
}
