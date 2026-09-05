import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

/**
 * Traduce al español los mensajes de error de Multer.
 *
 * `@nestjs/platform-express` ya envuelve los errores crudos en un HttpException, pero reusa el
 * `message` original de Multer, que siempre está en inglés ("File too large") y rompe la convención
 * del resto de la API.
 *
 * Los detecta por texto exacto porque el HttpException ya transformado no expone ningún código ni
 * enum, y delega al manejador default de Nest cualquier otra excepción.
 */
const MULTER_MESSAGE_TRANSLATIONS: Record<string, string> = {
  'File too large': `El archivo excede el tamaño máximo permitido por el servidor (${Math.floor(
    MAX_UPLOAD_SAFETY_NET_BYTES / (1024 * 1024),
  )}MB)`,
  'Too many files': 'Se excedió la cantidad máxima de archivos permitidos',
  'Unexpected field': 'Se recibió un campo de archivo inesperado',
  'Too many parts': 'La petición contiene demasiadas partes',
  'Field name too long': 'El nombre de un campo es demasiado largo',
  'Field value too long': 'El valor de un campo es demasiado largo',
  'Too many fields': 'Se excedió la cantidad máxima de campos permitidos',
  'Field name missing': 'Falta el nombre de un campo',
  'Multipart: Boundary not found': 'La petición multipart está mal formada',
};

@Catch(HttpException)
export class MulterExceptionFilter extends BaseExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const translated = MULTER_MESSAGE_TRANSLATIONS[exception.message];
    if (!translated) {
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();
    const original = exception.getResponse();
    const body =
      typeof original === 'object' && original !== null
        ? { ...original, message: translated }
        : { message: translated };
    response.status(exception.getStatus()).json(body);
  }
}
