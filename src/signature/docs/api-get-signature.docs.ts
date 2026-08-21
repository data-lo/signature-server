import { applyDecorators } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import {
  BaseResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `GET /signature/:id` — datos de una firma. Oculto del Swagger publicado, ver `ApiGetSignatureFile`. */
export function ApiGetSignature() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiExcludeEndpoint(),
    ApiOperation({ summary: 'Obtener los datos de una firma por su UUID' }),
    ApiParam({
      name: 'id',
      description: 'Identificador único de la firma en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Firma encontrada y datos retornados correctamente',
      type: BaseResponse,
    }),
    ApiResponse({
      status: 404,
      description: 'No existe una firma registrada con el UUID proporcionado',
      type: NotFoundResponse,
    }),
  );
}
