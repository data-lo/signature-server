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
        'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía con el rol de sistema ADMIN del usuario autenticado (el creador queda como administrador de inmediato), y refresca el catálogo de cuentas en Redis. Antes de escribir nada valida que el plan de la cuenta activa incluya la cuenta empresarial (ORGANIZATION_ACCOUNT): el plan gratuito no la incluye, y una cuenta sin perfil de facturación se trata como gratuita',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa. Es el contexto contra cuyo plan se autoriza —la cuenta personal de quien paga, o la organización desde la que se está trabajando—, no la organización que se va a crear.',
      required: true,
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
    ApiResponse({
      status: 403,
      description:
        'El usuario no pertenece a la cuenta activa, o el plan de esa cuenta no incluye la cuenta empresarial (plan Free o cuenta sin perfil de facturación)',
    }),
  );
}
