import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { SignatureDeactivateResponse } from '../interfaces/signature-deactivate-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /signature/:id/deactivate` — sustituye la rúbrica por un PNG en blanco. */
export function ApiDeactivateSignature() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Desactivar la firma del usuario autenticado reemplazándola por una imagen en blanco',
    }),
    ApiParam({
      name: 'id',
      description:
        'Identificador único de la firma a desactivar en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description:
        'Firma desactivada correctamente. La imagen de firma es reemplazada por un PNG en blanco y la identificación oficial se conserva',
      type: SignatureDeactivateResponse,
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
