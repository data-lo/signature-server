import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { SubmitForAuthorizationResponse } from '../interfaces/responses/submit-for-authorization-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /document/:id/submit-for-authorization` — arranca el flujo y notifica al primer turno. */
export function ApiSubmitDocumentForAuthorization() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Enviar documento a autorización (notifica al primer firmante en turno)',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description:
        'Documento enviado a autorización exitosamente, firmante notificado por correo',
      type: SubmitForAuthorizationResponse,
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
