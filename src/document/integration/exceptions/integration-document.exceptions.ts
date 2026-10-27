import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { buildApiKeyErrorBody } from 'src/api-key/exceptions/api-key.exceptions';

/** Códigos estables de error de la API de integración de documentos. */
export enum INTEGRATION_DOCUMENT_ERROR_CODE_ENUM {
  TENANT_OVERRIDE_NOT_ALLOWED = 'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
  USER_NOT_FOUND = 'INTEGRATION_USER_NOT_FOUND',
  SCOPE_DENIED = 'INTEGRATION_SCOPE_DENIED',
  IDEMPOTENCY_KEY_REQUIRED = 'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_MISMATCH = 'INTEGRATION_IDEMPOTENCY_KEY_MISMATCH',
  IDEMPOTENCY_KEY_IN_PROGRESS = 'INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS',
  CREATOR_UNAVAILABLE = 'INTEGRATION_CREATOR_UNAVAILABLE',
  CREATOR_MEMBERSHIP_REVOKED = 'INTEGRATION_CREATOR_MEMBERSHIP_REVOKED',
  APPROVAL_NOT_SUPPORTED = 'INTEGRATION_APPROVAL_NOT_SUPPORTED',
}

/**
 * La petición trae un campo de organización, cuenta o autor (en query, header o body). Se rechaza
 * en vez de ignorarlo: un cliente que lo manda cree que elige el tenant, y no es así.
 */
export class TenantOverrideNotAllowedException extends BadRequestException {
  constructor(fields: string[]) {
    super(
      buildApiKeyErrorBody(
        HttpStatus.BAD_REQUEST,
        'Bad Request',
        `La organización, la cuenta y el autor salen de la API key; no se aceptan: ${fields.join(', ')}`,
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.TENANT_OVERRIDE_NOT_ALLOWED,
      ),
    );
  }
}

/**
 * El usuario no es miembro activo de la organización de la llave. Mismo 404 exista o no en otra
 * organización: la API no confirma nada fuera del tenant de la llave.
 */
export class IntegrationUserNotFoundException extends NotFoundException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.NOT_FOUND,
        'Not Found',
        'El usuario no existe en la organización',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.USER_NOT_FOUND,
      ),
    );
  }
}

/** La llave sólo tiene `DOCUMENT.READ + OWN` y se piden documentos de otro usuario. */
export class IntegrationScopeDeniedException extends ForbiddenException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        'Con DOCUMENT.READ_OWN la API key sólo puede consultar los documentos de su propio usuario',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.SCOPE_DENIED,
      ),
    );
  }
}

/** Falta `Idempotency-Key` o no es un valor válido. */
export class IdempotencyKeyRequiredException extends BadRequestException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.BAD_REQUEST,
        'Bad Request',
        'El header Idempotency-Key es obligatorio: de 1 a 255 caracteres ASCII visibles',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_REQUIRED,
      ),
    );
  }
}

/** La `Idempotency-Key` ya se usó en esta organización con otro archivo u otro payload. */
export class IdempotencyKeyMismatchException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'Este Idempotency-Key ya se usó con otro archivo o con otros datos. Usa una clave nueva para un documento nuevo.',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_MISMATCH,
      ),
    );
  }
}

/**
 * Otra petición con la misma `Idempotency-Key` todavía está creando el documento. El cliente
 * debe esperar y repetir: en cuanto termine, recibirá el documento de aquélla.
 */
export class IdempotencyKeyInProgressException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'Ya hay una petición en curso con este Idempotency-Key. Vuelve a intentarlo en unos segundos.',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_IN_PROGRESS,
      ),
    );
  }
}

/** El correo del creador es de un usuario desactivado o borrado. */
export class IntegrationCreatorUnavailableException extends UnprocessableEntityException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        'El creador indicado no puede crear documentos',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.CREATOR_UNAVAILABLE,
      ),
    );
  }
}

/**
 * El creador fue dado de baja de la organización. La integración no lo readmite: eso lo decide
 * un administrador.
 */
export class IntegrationCreatorMembershipRevokedException extends UnprocessableEntityException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        'El creador indicado fue dado de baja de la organización; un administrador debe reactivarlo',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.CREATOR_MEMBERSHIP_REVOKED,
      ),
    );
  }
}

/**
 * `document.requiresApproval: true` todavía no se admite: la aprobación exige elegir a un
 * aprobador de la organización, y el contrato de integración no tiene cómo indicarlo.
 */
export class IntegrationApprovalNotSupportedException extends BadRequestException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.BAD_REQUEST,
        'Bad Request',
        'La API de integración todavía no admite documentos con aprobación previa (requiresApproval: true)',
        INTEGRATION_DOCUMENT_ERROR_CODE_ENUM.APPROVAL_NOT_SUPPORTED,
      ),
    );
  }
}
