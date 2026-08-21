import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserMeResponse } from '../interfaces/response/user-me-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /api/v1/users/me` — snapshot cacheado del usuario autenticado. */
export function ApiGetMyProfile() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener el perfil cacheado del usuario autenticado',
      description:
        'Lee desde Redis DB 0 (key = CURP) el snapshot unificado de User + PersonalInformation para inicializar el store de onboarding en el cliente',
    }),
    ApiResponse({
      status: 200,
      description: 'Perfil obtenido correctamente',
      type: UserMeResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 404,
      description: 'Usuario no encontrado',
      type: NotFoundResponse,
    }),
  );
}
