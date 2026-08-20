import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { SignatureCoordinatesDto } from '../dto/signature-coordinates.dto';
import { DocumentUpdateResponse } from '../interfaces/responses/document-update-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /document/:id` — edición del documento mientras sigue en estatus CREATED. */
export function ApiUpdateDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar campos del documento (solo en estatus CREATED)',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiConsumes('application/json', 'multipart/form-data'),
    ApiBody({ type: SignatureCoordinatesDto }),
    ApiResponse({
      status: 200,
      description: 'Documento actualizado exitosamente',
      type: DocumentUpdateResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'El documento no se encuentra en estatus CREATED',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El documento no pertenece al usuario autenticado',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
