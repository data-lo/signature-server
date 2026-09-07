import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/payments/billing-state` */
export function ApiGetBillingState() {
  return applyDecorators(
    ApiOperation({
      summary: 'Estado de facturación del propietario de la cuenta activa',
      description:
        'Resuelve al propietario facturable de la cuenta activa (la cuenta personal, o la ORGANIZACIÓN completa si el contexto es una organización) y devuelve su estado de facturación leído de `billing_profiles`: si tiene una suscripción vigente y cuál es su plan. ' +
        'Es una consulta de sólo lectura: NO da de alta el perfil de facturación — una cuenta que nunca ha contratado responde 200 con los tres campos en su valor vacío, no 404. ' +
        'Es la consulta que el frontend hace al iniciar sesión, al cambiar de cuenta activa y al volver de Stripe Checkout; como el alta la confirma el webhook `invoice.paid` y no el retorno del navegador, justo después de pagar puede seguir respondiendo `hasActiveSubscription: false` durante unos segundos.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa que se consulta. Decide si se lee `billing_profiles.personal_account_id` o `billing_profiles.organization_id`, así que se valida que el usuario autenticado pertenezca a ella.',
    }),
    ApiResponse({
      status: 200,
      description:
        '`billingProfileId`, `hasActiveSubscription` (`status = ACTIVE`) y `currentPlanType`.',
    }),
    ApiResponse({
      status: 400,
      description: 'Falta el header X-Account-Id de la cuenta activa.',
    }),
    ApiResponse({
      status: 403,
      description: 'No perteneces a la cuenta activa (X-Account-Id).',
    }),
  );
}
