import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  VERIFICATION_MESSAGES,
  VERIFICATION_STATUS_ENUM,
} from './public-verification.types';

/**
 * Mensajes con que Nest traduce los errores de multer de "archivo de más o en otro campo" (ver
 * `transformException` en `@nestjs/platform-express`). Significan que no llegó UN archivo en
 * `file`, así que se responde como archivo no admitido.
 */
const UNSUPPORTED_UPLOAD_MESSAGES = new Set([
  'Unexpected field',
  'Too many files',
  'Too many parts',
  'Too many fields',
]);

/**
 * Errores de multer en `POST /document/public/verify`, respondidos con el mismo contrato que un
 * resultado de verificación (200 con `status`) en vez de un 4xx genérico:
 *
 * - Más de un archivo, o en otro campo → `UNSUPPORTED_FILE`.
 * - Demasiado grande (`PayloadTooLargeException`) o multipart mal formado o cortado →
 *   `INVALID_FILE`.
 *
 * Sólo se aplica a esta ruta (`@UseFilters`) y sólo atrapa esas dos excepciones: un 429 del
 * rate limiting o cualquier otro error sigue su camino normal. El mensaje original de multer no se
 * devuelve.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class PublicVerificationUploadFilter implements ExceptionFilter {
  /**
   * @param exception - Error de multer.
   * @param host - Contexto HTTP.
   * @returns Nada; escribe la respuesta.
   *
   * @example
   * ```ts
   * @UseFilters(PublicVerificationUploadFilter)
   * ```
   */
  catch(
    exception: PayloadTooLargeException | BadRequestException,
    host: ArgumentsHost,
  ): void {
    const status =
      exception instanceof BadRequestException &&
      UNSUPPORTED_UPLOAD_MESSAGES.has(exception.message)
        ? VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE
        : VERIFICATION_STATUS_ENUM.INVALID_FILE;
    const message = VERIFICATION_MESSAGES[status];

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.OK)
      .json({ success: true, message, data: { status, message } });
  }
}
