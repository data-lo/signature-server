import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/common/constants/file-upload.constants';

/**
 * Respuesta para un multipart que llegó cortado. Pasa cuando la subida se interrumpe a medias
 * (conexión caída, pestaña cerrada) o cuando un proxy intermedio trunca el cuerpo: el caso real
 * fue el rewrite de Next, que cortaba en 10 MB (ver `next.config.ts` en signature-app).
 */
export const INCOMPLETE_UPLOAD_MESSAGE =
  'La carga del archivo se interrumpió antes de completarse. Vuelve a intentarlo.';

/**
 * Traducción al español de los mensajes de multer y busboy que Nest convierte en `HttpException`
 * (ver `transformException` en `@nestjs/platform-express/multer/multer/multer.utils.js`).
 *
 * Los tres de multipart truncado o mal formado llegan con el prefijo `Multipart: ` que les agrega
 * Nest; antes no estaban aquí y el usuario veía "Multipart: Unexpected end of form" en inglés.
 */
const MULTER_MESSAGE_TRANSLATIONS: Record<string, string> = {
  'File too large': `El archivo excede el tamaño máximo permitido por el servidor (${Math.floor(MAX_UPLOAD_SAFETY_NET_BYTES / (1024 * 1024),)}MB)`,
  'Too many files': 'Se excedió la cantidad máxima de archivos permitidos',
  'Unexpected field': 'Se recibió un campo de archivo inesperado',
  'Too many parts': 'La petición contiene demasiadas partes',
  'Field name too long': 'El nombre de un campo es demasiado largo',
  'Field value too long': 'El valor de un campo es demasiado largo',
  'Too many fields': 'Se excedió la cantidad máxima de campos permitidos',
  'Field name missing': 'Falta el nombre de un campo',
  'Multipart: Boundary not found': 'La petición multipart está mal formada',
  'Multipart: Unexpected end of form': INCOMPLETE_UPLOAD_MESSAGE,
  'Multipart: Unexpected end of file': INCOMPLETE_UPLOAD_MESSAGE,
  'Multipart: Malformed part header': INCOMPLETE_UPLOAD_MESSAGE,
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
