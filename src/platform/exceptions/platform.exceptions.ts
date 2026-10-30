import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';

import { buildApiKeyErrorBody } from 'src/api-key/exceptions/api-key.exceptions';

/** Errores del módulo Platform. */

/**
 * Códigos estables de error del aprovisionamiento interno. Viajan en `code`, junto al `message`
 * legible, con el mismo cuerpo `{ statusCode, error, message, code }` que la administración de
 * API keys.
 */
export enum PLATFORM_ERROR_CODE_ENUM {
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH',
  RESERVED_FIELDS_NOT_ALLOWED = 'RESERVED_FIELDS_NOT_ALLOWED',
  INVALID_BILLING_PERIOD = 'INVALID_BILLING_PERIOD',
  OWNER_EMAIL_ALREADY_REGISTERED = 'OWNER_EMAIL_ALREADY_REGISTERED',
  OWNER_UNAVAILABLE = 'OWNER_UNAVAILABLE',
  EXTERNAL_REFERENCE_ALREADY_USED = 'EXTERNAL_REFERENCE_ALREADY_USED',
  CONCURRENT_PROVISIONING = 'CONCURRENT_PROVISIONING',
}

/** Falta `Idempotency-Key` o no tiene de 1 a 255 caracteres ASCII visibles. */
export class ProvisioningIdempotencyKeyRequiredException extends BadRequestException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.BAD_REQUEST,
        'Bad Request',
        'El header Idempotency-Key es obligatorio (1 a 255 caracteres ASCII visibles, sin espacios)',
        PLATFORM_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_REQUIRED,
      ),
    );
  }
}

/** El `Idempotency-Key` ya se usó para aprovisionar con otro contenido. */
export class ProvisioningIdempotencyKeyMismatchException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'Este Idempotency-Key ya se usó para aprovisionar con otros datos; usa una clave nueva',
        PLATFORM_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_MISMATCH,
      ),
    );
  }
}

/** El request intenta elegir lo que decide el backend (plan, permisos, importe…). */
export class ProvisioningReservedFieldsException extends BadRequestException {
  constructor(fields: string[]) {
    super(
      buildApiKeyErrorBody(
        HttpStatus.BAD_REQUEST,
        'Bad Request',
        `Estos campos los define el backend y no se aceptan: ${fields.join(', ')}`,
        PLATFORM_ERROR_CODE_ENUM.RESERVED_FIELDS_NOT_ALLOWED,
      ),
    );
  }
}

/** `billing.periodEnd` no es posterior a `billing.periodStart`. */
export class ProvisioningInvalidBillingPeriodException extends UnprocessableEntityException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        'billing.periodEnd debe ser posterior a billing.periodStart',
        PLATFORM_ERROR_CODE_ENUM.INVALID_BILLING_PERIOD,
      ),
    );
  }
}

/**
 * El correo del propietario es de un usuario que ya completó su registro (`ACTIVE`). Una cuenta
 * provisional de pruebas no se cuelga de la cuenta real de una persona.
 */
export class ProvisionalOwnerEmailAlreadyRegisteredException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'El correo del propietario ya pertenece a un usuario registrado; usa un correo sin cuenta o de un usuario provisional',
        PLATFORM_ERROR_CODE_ENUM.OWNER_EMAIL_ALREADY_REGISTERED,
      ),
    );
  }
}

/** El correo del propietario es de un usuario provisional desactivado o borrado. */
export class ProvisionalOwnerUnavailableException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'El correo del propietario pertenece a un usuario desactivado; usa otro correo',
        PLATFORM_ERROR_CODE_ENUM.OWNER_UNAVAILABLE,
      ),
    );
  }
}

/** `billing.externalReference` ya se registró en otro periodo manual de la plataforma. */
export class ProvisioningExternalReferenceAlreadyUsedException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'billing.externalReference ya está registrada en otro periodo; usa un folio nuevo',
        PLATFORM_ERROR_CODE_ENUM.EXTERNAL_REFERENCE_ALREADY_USED,
      ),
    );
  }
}

/** Otra petición aprovisionó a la vez con el mismo correo; reintentar resuelve. */
export class ConcurrentProvisioningException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'Otra operación de aprovisionamiento con los mismos datos se ejecutó a la vez; reintenta',
        PLATFORM_ERROR_CODE_ENUM.CONCURRENT_PROVISIONING,
      ),
    );
  }
}
