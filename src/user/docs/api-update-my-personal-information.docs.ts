import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PersonalInformationResponse } from '../interfaces/response/personal-information-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PUT /api/v1/users/me/personal-information` — campos pendientes de onboarding. */
export function ApiUpdateMyPersonalInformation() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar información personal del usuario autenticado',
      description:
        'Actualiza en PostgreSQL los campos pendientes (teléfono, correo secundario) de onboarding. El usuario se identifica mediante el JWT.',
    }),
    ApiResponse({
      status: 200,
      description: 'Información personal actualizada correctamente',
      type: PersonalInformationResponse,
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
