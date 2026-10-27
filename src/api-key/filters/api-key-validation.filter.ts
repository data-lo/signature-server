import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

import {
  API_KEY_ERROR_CODE_ENUM,
  buildApiKeyErrorBody,
} from '../exceptions/api-key.exceptions';

/**
 * Responde 422 en vez de 400 cuando el body o los parámetros de estos endpoints no pasan la
 * validación, como pide el contrato de la historia.
 *
 * El `ValidationPipe` global responde 400 en toda la API y no se cambia desde aquí: lo único que
 * se ajusta es la respuesta de las rutas de `OrganizationApiKeysController`, que es donde se
 * declara este filtro. Los mensajes de class-validator se conservan tal cual en `message`.
 */
@Catch(BadRequestException)
export class ApiKeyValidationFilter implements ExceptionFilter {
  /**
   * Reescribe el 400 como 422 con `code: API_KEY_INVALID_BODY`.
   *
   * @param exception - El 400 lanzado por la validación.
   * @param host - Contexto de la petición.
   * @returns Nada; escribe la respuesta.
   *
   * @example
   * ```ts
   * @UseFilters(ApiKeyValidationFilter)
   * @Controller('organizations/:organizationId/api-keys')
   * export class OrganizationApiKeysController {}
   * ```
   */
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse();
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? (body as { message: string | string[] }).message
        : exception.message;

    response
      .status(HttpStatus.UNPROCESSABLE_ENTITY)
      .json(
        buildApiKeyErrorBody(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Unprocessable Entity',
          message,
          API_KEY_ERROR_CODE_ENUM.API_KEY_INVALID_BODY,
        ),
      );
  }
}
