import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Códigos estables de los errores de validación de una firma pública. La pantalla decide qué
 * mostrar por el código, nunca por el texto.
 */
export enum SIGNING_VALIDATION_ERROR_CODE_ENUM {
  /** No se validó el código del correo que la política exige. */
  EMAIL_VERIFICATION_REQUIRED = 'EMAIL_VERIFICATION_REQUIRED',
  /** La verificación de identidad (Didit) no se ha hecho o no ha terminado. */
  IDENTITY_VERIFICATION_REQUIRED = 'IDENTITY_VERIFICATION_REQUIRED',
  /** Didit rechazó la identidad, falló o venció. */
  IDENTITY_VERIFICATION_REJECTED = 'IDENTITY_VERIFICATION_REJECTED',
  /** Didit aprobó, pero los datos leídos no corresponden al firmante esperado. */
  IDENTITY_DATA_MISMATCH = 'IDENTITY_DATA_MISMATCH',
  /** Certificado inválido, vencido, no confiable o cuya llave/contraseña no corresponde. */
  CERTIFICATE_INVALID = 'CERTIFICATE_INVALID',
  /** El SAT reporta el certificado como revocado. */
  CERTIFICATE_REVOKED = 'CERTIFICATE_REVOKED',
  /** El titular del certificado no es el colaborador esperado. */
  CERTIFICATE_SUBJECT_MISMATCH = 'CERTIFICATE_SUBJECT_MISMATCH',
  /** La firma producida no corresponde al documento revisado o a su hash. */
  SIGNATURE_VALIDATION_FAILED = 'SIGNATURE_VALIDATION_FAILED',
  /** La sesión pública de firma venció o ya no es válida. */
  SIGNING_SESSION_EXPIRED = 'SIGNING_SESSION_EXPIRED',
  /** El firmante todavía no puede firmar (turno, estado del documento o del colaborador). */
  SIGNING_NOT_AVAILABLE = 'SIGNING_NOT_AVAILABLE',
}

/** Cuerpo uniforme de los errores de validación de firma. */
export interface SigningValidationErrorBody {
  statusCode: number;
  error: string;
  code: SIGNING_VALIDATION_ERROR_CODE_ENUM | null;
  message: string;
}

/**
 * Error de validación de una firma, con su código estable en el cuerpo:
 * `{ statusCode, error, code, message }`.
 *
 * @example
 * ```ts
 * throw new SigningValidationException(
 *   SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNING_NOT_AVAILABLE,
 *   'Todavía no es tu turno para firmar.',
 * );
 * ```
 */
export class SigningValidationException extends HttpException {
  constructor(
    readonly code: SIGNING_VALIDATION_ERROR_CODE_ENUM,
    message: string,
    status: HttpStatus = SIGNING_VALIDATION_STATUS[code],
  ) {
    super(
      {
        statusCode: status,
        error: HttpStatus[status]
          .split('_')
          .map((word) => word[0] + word.slice(1).toLowerCase())
          .join(' '),
        code,
        message,
      } satisfies SigningValidationErrorBody,
      status,
    );
  }
}

/** Estado HTTP de cada código. */
export const SIGNING_VALIDATION_STATUS: Record<
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  HttpStatus
> = {
  EMAIL_VERIFICATION_REQUIRED: HttpStatus.FORBIDDEN,
  IDENTITY_VERIFICATION_REQUIRED: HttpStatus.FORBIDDEN,
  IDENTITY_VERIFICATION_REJECTED: HttpStatus.FORBIDDEN,
  IDENTITY_DATA_MISMATCH: HttpStatus.FORBIDDEN,
  CERTIFICATE_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  CERTIFICATE_REVOKED: HttpStatus.UNPROCESSABLE_ENTITY,
  CERTIFICATE_SUBJECT_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  SIGNATURE_VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  SIGNING_SESSION_EXPIRED: HttpStatus.UNAUTHORIZED,
  SIGNING_NOT_AVAILABLE: HttpStatus.CONFLICT,
};

/** El titular del certificado no corresponde al colaborador. */
export class CertificateSubjectMismatchException extends SigningValidationException {
  constructor() {
    super(
      SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_SUBJECT_MISMATCH,
      'El titular de la e.firma no corresponde a la persona invitada a firmar este documento.',
    );
  }
}

/** La firma producida no se pudo verificar contra el documento revisado. */
export class SignatureValidationFailedException extends SigningValidationException {
  constructor() {
    super(
      SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNATURE_VALIDATION_FAILED,
      'La firma no corresponde al documento que revisaste. Vuelve a abrirlo y firma de nuevo.',
    );
  }
}
