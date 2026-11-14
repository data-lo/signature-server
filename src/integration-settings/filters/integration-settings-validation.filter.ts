import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

import { buildApiKeyErrorBody } from 'src/api-key/exceptions/api-key.exceptions';

import { INTEGRATION_SETTINGS_ERROR_CODE_ENUM } from '../exceptions/integration-settings.exceptions';

/**
 * Convierte el `400` del `ValidationPipe` en `422 INTEGRATION_SETTINGS_INVALID_BODY`, con el mismo
 * cuerpo que `ApiKeyValidationFilter` para la pantalla de Integraciones.
 */
@Catch(BadRequestException)
export class IntegrationSettingsValidationFilter implements ExceptionFilter {
  /**
   * Responde el error de validación con su código.
   *
   * @param exception - Error del `ValidationPipe`.
   * @param host - Contexto de la petición.
   * @returns Nada; escribe la respuesta.
   *
   * @example
   * ```ts
   * @UseFilters(IntegrationSettingsValidationFilter)
   * @Controller('organizations/:organizationId/integration-settings')
   * export class IntegrationSettingsController {}
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
          INTEGRATION_SETTINGS_ERROR_CODE_ENUM.INTEGRATION_SETTINGS_INVALID_BODY,
        ),
      );
  }
}
