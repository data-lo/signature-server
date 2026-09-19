import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { AuthorizationContextResponse } from '../interfaces/response/authorization-context-response';

/** `GET /api/v1/authorization/context` — permisos efectivos de la cuenta activa. */
export function ApiGetAuthorizationContext() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener el contexto de autorización de la cuenta activa',
      description:
        'Devuelve la cuenta activa, su organización, su rol y las claves del catálogo estático ' +
        'que ese rol otorga. Sirve para que el cliente pinte el menú y las acciones; NO autoriza ' +
        'ninguna operación: cada endpoint vuelve a validar su propio permiso.',
    }),
    ApiHeader({
      name: 'X-Active-Account-Id',
      required: true,
      description:
        'Membresía desde la que actúa el usuario. Se acepta `X-Account-Id` como alternativa, ' +
        'que es el header que ya manda el resto de la API.',
    }),
    ApiResponse({
      status: 200,
      description: 'Contexto de autorización obtenido correctamente',
      type: AuthorizationContextResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'La petición no declara cuenta activa',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'La cuenta no existe, no es del usuario autenticado o su membresía está dada de baja',
    }),
  );
}
