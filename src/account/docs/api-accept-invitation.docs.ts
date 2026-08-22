import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations/invitations/:token/accept` — alta de membresía por RFC. */
export function ApiAcceptInvitation() {
  return applyDecorators(
    ApiOperation({
      summary: 'Aceptar una invitación (usuario ya registrado)',
      description:
        'Público (sin JWT) — Camino A de la historia: resuelve al usuario por RFC (no requiere sesión iniciada) y crea su membresía en la organización.',
    }),
    ApiParam({ name: 'token', description: 'Token de la invitación' }),
    ApiResponse({
      status: 200,
      description: 'Te uniste a la organización correctamente',
      type: BaseResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        'Invitación no encontrada, o ningún usuario registrado con ese RFC',
      type: NotFoundResponse,
    }),
    ApiResponse({
      status: 409,
      description:
        'La invitación ya fue utilizada, o el usuario ya es miembro de la organización',
    }),
    ApiResponse({
      status: 410,
      description: 'La invitación ya expiró',
    }),
  );
}
