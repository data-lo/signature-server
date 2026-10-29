import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  SigningValidationErrorBody,
  SigningValidationException,
} from 'src/document/exceptions/signing-validation.exceptions';
import {
  CadenaConfianzaInvalidaException,
  CertificadoExpiradoException,
  CertificadoInvalidoException,
  CertificadoRevocadoException,
  LLaveNoCorrespondeCertificadoException,
  LLavePrivadaInvalidException,
} from 'src/efirma/efirma.exceptions';

import { InvalidPublicSigningSessionException } from '../guards/public-signing-session.guard';

/** Excepciones de la e.firma que significan "este certificado no sirve". */
const CERTIFICATE_INVALID_EXCEPTIONS = [
  CertificadoInvalidoException,
  CertificadoExpiradoException,
  CadenaConfianzaInvalidaException,
  LLavePrivadaInvalidException,
  LLaveNoCorrespondeCertificadoException,
];

/**
 * Código estable de un error de la firma pública, o `null` si no es uno de validación.
 *
 * @param error - Lo que se lanzó.
 * @returns El código.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * signingErrorCode(new CertificadoRevocadoException()); // 'CERTIFICATE_REVOKED'
 * ```
 */
export function signingErrorCode(
  error: unknown,
): SIGNING_VALIDATION_ERROR_CODE_ENUM | null {
  if (error instanceof SigningValidationException) return error.code;
  if (error instanceof InvalidPublicSigningSessionException) {
    return SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNING_SESSION_EXPIRED;
  }
  if (error instanceof CertificadoRevocadoException) {
    return SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_REVOKED;
  }
  if (CERTIFICATE_INVALID_EXCEPTIONS.some((type) => error instanceof type)) {
    return SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_INVALID;
  }
  return null;
}

/**
 * Da a todos los errores de la sesión pública de firma la misma forma:
 * `{ statusCode, error, code, message }`. `code` es el código estable de la validación que falló
 * (`SIGNING_VALIDATION_ERROR_CODE_ENUM`) o `null` para cualquier otro error. Los errores de la
 * e.firma conservan su estado y su mensaje (que explican qué corregir) y ganan su código.
 *
 * Un error que no es HTTP sale como 500 genérico, sin detalle: el detalle va sólo al log.
 */
@Catch()
export class PublicSigningErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicSigningErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Error no controlado en la firma pública: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal Server Error',
        code: null,
        message:
          'Ocurrió un error inesperado. Intenta de nuevo en unos momentos.',
      } satisfies SigningValidationErrorBody);
      return;
    }

    const status = exception.getStatus();
    const original = exception.getResponse();
    const body =
      typeof original === 'object' && original !== null
        ? (original as Record<string, unknown>)
        : { message: original };
    const message = Array.isArray(body.message)
      ? body.message.join(', ')
      : String(body.message ?? exception.message);

    response.status(status).json({
      statusCode: status,
      error:
        typeof body.error === 'string'
          ? body.error
          : (HttpStatus[status] ?? 'Error'),
      code: signingErrorCode(exception),
      message,
    } satisfies SigningValidationErrorBody);
  }
}
