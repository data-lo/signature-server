import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountResponse } from '../interfaces/response/account-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations` — alta transaccional de la organización y su ADMIN. */
export function ApiCreateOrganization() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear una organización',
      description:
        'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía con el rol de sistema ADMIN del usuario autenticado (el creador queda como administrador de inmediato), y refresca el catálogo de cuentas en Redis',
    }),
    ApiResponse({
      status: 201,
      description: 'Organización creada correctamente',
      type: AccountResponse,
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
  );
}
