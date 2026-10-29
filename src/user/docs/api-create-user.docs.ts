import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { UserCreateResponse } from '../interfaces/response/user-create-response';
import {
  BadRequestResponse,
  ConflictResponse,
} from 'src/interfaces/api-response.dto';

/**
 * `POST /user` — alta de usuario desde la API pública.
 *
 * `ApiSecurity('x-api-key')` viaja aquí y no en el controlador porque solo documenta: quien de
 * verdad abre la ruta a la API key es `@Public()`, que sigue siendo un decorador de comportamiento
 * y se queda junto a la ruta.
 */
export function ApiCreateUser() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiOperation({
      summary: 'Crear nuevo usuario',
      description: 'Registra un nuevo usuario en el sistema',
    }),
    ApiResponse({
      status: 201,
      description: 'Usuario creado correctamente',
      type: UserCreateResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Los datos enviados son inválidos o incompletos',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description: 'API Key inválida o no proporcionada',
    }),
    ApiResponse({
      status: 409,
      description: 'Ya existe un usuario registrado con ese correo electrónico',
      type: ConflictResponse,
    }),
  );
}
