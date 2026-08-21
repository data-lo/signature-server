import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { UpdateSignatureDto } from '../dto/update-signature.dto';
import { SignatureUpdateReponse } from '../interfaces/signature-update-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/**
 * `PATCH /signature/:id` — reemplazo de la rúbrica y/o la identificación oficial.
 *
 * `ApiConsumes`/`ApiBody` describen el multipart; el `FileFieldsInterceptor` que lo procesa se
 * queda en el controlador, porque es comportamiento.
 */
export function ApiUpdateSignature() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Actualizar la imagen de firma y/o identificación oficial del usuario autenticado',
    }),
    ApiParam({
      name: 'id',
      description:
        'Identificador único de la firma a actualizar en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: UpdateSignatureDto }),
    ApiResponse({
      status: 200,
      description: 'Firma actualizada correctamente',
      type: SignatureUpdateReponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'La firma no pertenece al usuario autenticado',
    }),
    ApiResponse({
      status: 404,
      description: 'No existe una firma registrada con el UUID proporcionado',
      type: NotFoundResponse,
    }),
  );
}
