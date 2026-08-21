import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /api/v1/users/me/status` — consolida el onboarding (isConfigured). */
export function ApiCompleteMyOnboarding() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consolidar el estado de onboarding del usuario autenticado',
      description:
        'Marca isConfigured=true de forma atómica en PostgreSQL y refresca el cache unificado en Redis. El usuario se identifica mediante el JWT.',
    }),
    ApiResponse({
      status: 200,
      description: 'Estado de configuración actualizado correctamente',
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
