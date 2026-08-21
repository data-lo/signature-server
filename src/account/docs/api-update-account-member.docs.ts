import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AccountMemberResponse } from '../interfaces/response/account-member-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /account-member/:id` — rol, puesto o vigencia de una membresía. */
export function ApiUpdateAccountMember() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar una membresía',
      description:
        'Actualiza el rol, puesto o vigencia del acceso. Solo un ADMIN activo de la cuenta de esa membresía puede hacerlo.',
    }),
    ApiParam({
      name: 'id',
      description: 'Identificador único de la membresía en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Membresía actualizada correctamente',
      type: AccountMemberResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta cuenta',
    }),
    ApiResponse({
      status: 404,
      description: 'Membresía no encontrada',
      type: NotFoundResponse,
    }),
  );
}
