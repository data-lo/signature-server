import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountResponse } from '../interfaces/response/account-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations` — alta transaccional de la organización y su ADMIN. */
export function ApiCreateOrganization() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear una organización',
      description:
        'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía con el rol de sistema ADMIN del usuario autenticado (el creador queda como administrador de inmediato), y refresca el catálogo de cuentas en Redis. NO depende del plan: cualquier usuario que pertenezca a la cuenta activa puede crear una organización, esté en Free o sin suscripción. La organización nace SIN perfil de facturación —sin plan Free y sin créditos de bienvenida—, así que `GET /payments/billing-state` le responde sin plan y con todas las acciones en false hasta que contrate una suscripción.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa desde la que se pide el alta. Se valida que el usuario autenticado pertenezca a ella; no es la organización que se va a crear.',
      required: true,
    }),
    ApiResponse({
      status: 201,
      description: 'Organización creada correctamente',
      type: AccountResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Los datos enviados son inválidos o incompletos, o falta el header X-Account-Id',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario no pertenece a la cuenta activa',
    }),
  );
}
