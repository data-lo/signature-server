import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `PUT /api/v1/users/me/password` — cambio de contraseña con la sesión iniciada. */
export function ApiChangeMyPassword() {
  return applyDecorators(
    ApiOperation({
      summary: 'Cambiar la contraseña del usuario autenticado',
      description:
        'Verifica la contraseña actual y, si coincide, guarda la nueva en el usuario y en sus cuentas (la credencial contra la que resuelve el login). Las sesiones abiertas siguen siendo válidas, incluida la que hace el cambio.',
    }),
    ApiResponse({
      status: 200,
      description: 'Contraseña actualizada correctamente',
    }),
    ApiResponse({
      status: 400,
      description:
        'La contraseña nueva no cumple el mínimo o no coincide con su confirmación',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token inválido/expirado, o la contraseña actual no es correcta',
    }),
  );
}
