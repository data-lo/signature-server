import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { OrganizationMemberResponse } from '../interfaces/response/account-member-response';

/** `POST /api/v1/organizations/members` — alta directa de un miembro en la organización activa. */
export function ApiAddOrganizationMember() {
  return applyDecorators(
    ApiOperation({
      summary: 'Agregar un miembro a la organización activa',
      description:
        'Da de alta como miembro a un usuario YA registrado y le asigna un rol organizacional. Sus permisos son los del rol: esta ruta no guarda permisos por persona. Para alguien que todavía no tiene cuenta, usar POST /api/v1/organizations/invite. Solo un miembro con permiso ORGANIZATION:CREATE (rol ADMIN) puede agregarlos, y siempre en la organización del header X-Account-Id.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la membresía del llamador en la organización activa; de ella se resuelve la organización donde se da el alta',
      required: true,
    }),
    ApiResponse({
      status: 201,
      description: 'Miembro agregado correctamente',
      type: OrganizationMemberResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta el header X-Account-Id, el cuerpo es inválido, o la cuenta activa no es de tipo ORGANIZATION',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
    ApiResponse({
      status: 404,
      description:
        'No existe un usuario registrado con ese correo, o el rol no existe / pertenece a otra organización',
    }),
    ApiResponse({
      status: 409,
      description:
        'Esa persona ya tiene una membresía en la organización (activa o dada de baja)',
    }),
  );
}
