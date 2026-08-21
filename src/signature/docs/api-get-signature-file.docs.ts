import { applyDecorators } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/**
 * `GET /signature/files/:fileId` — URL prefirmada de un objeto de MinIO.
 *
 * Documentado pero OCULTO del Swagger publicado (`ApiExcludeEndpoint`), tal como estaba antes de
 * extraer los decoradores: la descripción se conserva para quien lea el código, sin exponer la
 * ruta en el portal. `ApiSecurity` solo documenta; quien abre la ruta a la API key es `@Public()`,
 * que se queda en el controlador.
 */
export function ApiGetSignatureFile() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiExcludeEndpoint(),
    ApiOperation({
      summary: 'Obtener URL prefirmada de un archivo almacenado en MinIO',
    }),
    ApiParam({
      name: 'fileId',
      description:
        'Clave del objeto en MinIO (object key) del archivo a recuperar',
    }),
    ApiResponse({
      status: 200,
      description: 'URL prefirmada generada correctamente',
    }),
    ApiResponse({
      status: 404,
      description: 'Archivo no encontrado en el bucket indicado',
      type: NotFoundResponse,
    }),
  );
}
