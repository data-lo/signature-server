import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountMemberResponse } from '../interfaces/response/account-member-response';
import {
  BadRequestResponse,
  ConflictResponse,
} from 'src/interfaces/api-response.dto';

/** `POST /account-member` — asocia un usuario a una cuenta con un rol. */
export function ApiGrantAccountAccess() {
  return applyDecorators(
    ApiOperation({
      summary: 'Otorgar acceso a una cuenta',
      description:
        'Asocia un usuario a una cuenta con un rol (ver GET /api/v1/roles). Solo un ADMIN activo de esa cuenta puede otorgar acceso.',
    }),
    ApiResponse({
      status: 201,
      description: 'Acceso otorgado correctamente',
      type: AccountMemberResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Los datos enviados son inválidos o incompletos',
      type: BadRequestResponse,
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
      status: 409,
      description: 'El usuario ya tiene acceso a esta cuenta',
      type: ConflictResponse,
    }),
  );
}
