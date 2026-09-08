import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/payments/billing-state` */
export function ApiGetBillingState() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Estado comercial de la cuenta activa: plan, saldo, beneficios y límites',
      description:
        'Fuente ÚNICA del estado de facturación y del acceso efectivo. Resuelve al propietario facturable de la cuenta activa (la cuenta personal, o la ORGANIZACIÓN completa si el contexto es una organización) y devuelve, en una sola respuesta: el perfil (`billingProfileId`, `status`, `currentPlanType`, `billingSource`, `cancelAtPeriodEnd`, periodo vigente), el saldo de documentos utilizable (`creditsAvailable`), y lo que el plan habilita (`actions`) con sus topes (`limits`). ' +
        'Sustituye a `GET /payments/subscription`, que describe el mismo perfil con menos campos y obliga a decidir qué habilitar a partir del NOMBRE del plan. ' +
        '`actions` y `limits` son para la EXPERIENCIA DE USUARIO —habilitar, ocultar, ofrecer la mejora— y no autorizan nada: cada acción protegida se vuelve a validar en su propio endpoint contra el mismo mapa de beneficios. ' +
        'Los beneficios se resuelven de una configuración estática por `currentPlanType` (`free`, `plus`, `premium`, `enterprise`, `partners`); un plan que no esté en ella responde con los beneficios del gratuito. El precio del documento extra NO viaja acá: sale de `catalog_prices` por `eligible_plan_type`. ' +
        'Es una consulta de sólo lectura: NO da de alta el perfil de facturación — una cuenta que nunca ha contratado responde 200 con los campos de perfil en nulo, `creditsAvailable: 0` y las acciones del plan gratuito, no 404. ' +
        'Es la consulta que el frontend hace al iniciar sesión, al cambiar de cuenta activa, al volver de Stripe Checkout y después de cada movimiento de facturación; como el alta la confirma el webhook `invoice.paid` y no el retorno del navegador, justo después de pagar puede seguir respondiendo `hasActiveSubscription: false` durante unos segundos.',
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
        'Estado del perfil, `creditsAvailable`, `actions` (15 banderas por acción) y `limits` (`documentsIncludedPerPeriod`, `maxOrganizationMembers`; `null` = no lo fija el plan).',
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
