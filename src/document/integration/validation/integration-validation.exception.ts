import { HttpStatus, UnprocessableEntityException } from '@nestjs/common';

/**
 * Códigos estables de los errores de validación del payload de integración.
 *
 * Son contrato con el sistema externo: un cliente decide qué hacer leyendo el código, no el
 * mensaje, así que renombrarlos es un cambio incompatible.
 */
export enum INTEGRATION_VALIDATION_CODE_ENUM {
  /** El archivo no es un PDF legible (tipo, contenido o estructura). */
  INVALID_DOCUMENT_FILE = 'INVALID_DOCUMENT_FILE',
  /** `payload` falta, no es JSON o no es un objeto. */
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  /** Un campo de `creator` falta o no es válido. */
  INVALID_CREATOR = 'INVALID_CREATOR',
  /** Un campo de `document` falta o no es válido. */
  INVALID_DOCUMENT_OPTIONS = 'INVALID_DOCUMENT_OPTIONS',
  PARTICIPANTS_REQUIRED = 'PARTICIPANTS_REQUIRED',
  SIGNER_REQUIRED = 'SIGNER_REQUIRED',
  MAX_PARTICIPANTS_EXCEEDED = 'MAX_PARTICIPANTS_EXCEEDED',
  INVALID_PARTICIPANT_ROLE = 'INVALID_PARTICIPANT_ROLE',
  INVALID_PARTICIPANT_NAME = 'INVALID_PARTICIPANT_NAME',
  INVALID_PARTICIPANT_EMAIL = 'INVALID_PARTICIPANT_EMAIL',
  DUPLICATE_PARTICIPANT_EMAIL = 'DUPLICATE_PARTICIPANT_EMAIL',
  SIGNER_SIGNATURE_POSITION_REQUIRED = 'SIGNER_SIGNATURE_POSITION_REQUIRED',
  WITNESS_SIGNATURE_POSITION_NOT_ALLOWED = 'WITNESS_SIGNATURE_POSITION_NOT_ALLOWED',
  MAX_SIGNATURE_POSITIONS_EXCEEDED = 'MAX_SIGNATURE_POSITIONS_EXCEEDED',
  INVALID_SIGNING_ORDER = 'INVALID_SIGNING_ORDER',
  DUPLICATE_SIGNING_ORDER = 'DUPLICATE_SIGNING_ORDER',
  INVALID_SIGNATURE_POSITION = 'INVALID_SIGNATURE_POSITION',
  SIGNATURE_POSITION_PAGE_OUT_OF_RANGE = 'SIGNATURE_POSITION_PAGE_OUT_OF_RANGE',
  SIGNATURE_POSITION_OVERLAP = 'SIGNATURE_POSITION_OVERLAP',
}

/** Detalles del error: el campo afectado (si aplica) y los datos que lo explican. */
export type IntegrationValidationDetails = Record<string, unknown>;

/** Cuerpo que lleva la excepción; `IntegrationErrorFilter` lo envuelve en `{ success, error }`. */
export interface IntegrationErrorBody {
  code: string;
  message: string;
  details?: IntegrationValidationDetails;
}

/**
 * Un error de validación del payload de integración: siempre `422`, con un código estable, un
 * mensaje legible y los detalles del campo afectado.
 *
 * @example
 * ```ts
 * throw new IntegrationValidationException(
 *   INTEGRATION_VALIDATION_CODE_ENUM.DUPLICATE_PARTICIPANT_EMAIL,
 *   'Un colaborador sólo puede participar una vez en el documento.',
 *   { field: 'participants[2].email', email: 'ana@correo.com' },
 * );
 * ```
 */
export class IntegrationValidationException extends UnprocessableEntityException {
  constructor(
    code: INTEGRATION_VALIDATION_CODE_ENUM,
    message: string,
    details?: IntegrationValidationDetails,
  ) {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code,
      message,
      ...(details && { details }),
    });
  }
}
