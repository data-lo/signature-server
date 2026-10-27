import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/** Forma de todo error de la API de integración. */
export interface IntegrationErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Código por estado HTTP, para las excepciones que no traen uno propio. */
const STATUS_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.PAYMENT_REQUIRED]: 'INSUFFICIENT_DOCUMENT_CREDITS',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

const INTERNAL_ERROR_MESSAGE =
  'Ocurrió un error interno. Vuelve a intentarlo más tarde.';

/**
 * Da a TODOS los errores de la API de integración la misma forma:
 * `{ success: false, error: { code, message, details? } }`.
 *
 * - Una excepción con `code` propio (validación del payload, API key, idempotencia, tenant)
 *   conserva su estado, su código, su mensaje y sus `details`.
 * - Un 400 del `ValidationPipe` global (query o campos del body con validadores de class-validator)
 *   pasa a `422 INVALID_REQUEST`, con la lista de reglas incumplidas en `details.errors`: los
 *   errores de validación de esta API son 422.
 * - Cualquier otra `HttpException` conserva su estado y recibe un código por estado.
 * - Lo que no es `HttpException` —TypeORM, MinIO, Kafka, un bug— responde `500 INTERNAL_ERROR`
 *   con un mensaje genérico. El detalle sólo va al log del servidor, nunca al cliente: ni el texto
 *   del driver ni el stack trace.
 */
@Catch()
export class IntegrationErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(IntegrationErrorFilter.name);

  /**
   * Escribe la respuesta de error con el formato de integración.
   *
   * @param exception - Lo que se lanzó al atender la petición.
   * @param host - Contexto de la petición.
   * @returns Nada; escribe la respuesta.
   *
   * @example
   * ```ts
   * @UseFilters(IntegrationErrorFilter)
   * @Controller('integration')
   * export class IntegrationDocumentsController {}
   * ```
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);

    response.status(status).json(body);
  }

  private toResponse(exception: unknown): {
    status: number;
    body: IntegrationErrorResponse;
  } {
    if (!(exception instanceof HttpException)) {
      const error = exception instanceof Error ? exception : null;
      this.logger.error(
        `Error no controlado en la API de integración: ${error?.name ?? typeof exception}: ${error?.message ?? ''}`,
        error?.stack,
      );
      return failure(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        INTERNAL_ERROR_MESSAGE,
      );
    }

    const status = exception.getStatus();
    const raw = exception.getResponse();
    const body: Record<string, unknown> =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : { message: raw };

    if (typeof body.code === 'string') {
      return failure(
        status,
        body.code,
        messageOf(body.message, exception.message),
        body.details as Record<string, unknown> | undefined,
      );
    }

    if (status === HttpStatus.BAD_REQUEST && Array.isArray(body.message)) {
      return failure(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_REQUEST',
        'La petición tiene campos inválidos.',
        { errors: body.message },
      );
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Error ${status} en la API de integración: ${exception.message}`,
        exception.stack,
      );
      return failure(status, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
    }

    return failure(
      status,
      STATUS_CODES[status] ?? 'HTTP_ERROR',
      messageOf(body.message, exception.message),
    );
  }
}

function failure(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { status: number; body: IntegrationErrorResponse } {
  return {
    status,
    body: {
      success: false,
      error: { code, message, ...(details && { details }) },
    },
  };
}

function messageOf(message: unknown, fallback: string): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return fallback;
}
