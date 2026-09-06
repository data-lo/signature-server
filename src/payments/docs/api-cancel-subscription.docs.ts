import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/payments/subscription/cancel` */
export function ApiCancelSubscription() {
  return applyDecorators(
    ApiOperation({
      summary: 'Programar la baja de la suscripción al final del periodo',
      description:
        'Le pide a Stripe que no renueve la suscripción (`cancel_at_period_end`) y marca la baja en el perfil de facturación. ' +
        'NO cancela nada de inmediato: el perfil sigue ACTIVE y conserva su plan, su periodo, su suscripción y sus créditos hasta `currentPeriodEnd`, que es la fecha efectiva de término que devuelve la respuesta. ' +
        'La base local se escribe sólo después de que Stripe confirme, y el webhook `customer.subscription.updated` vuelve a sincronizar el valor —así también entran las bajas y reactivaciones hechas desde el Dashboard de Stripe—. ' +
        'Al llegar la fecha, `customer.subscription.deleted` es quien mueve el perfil a CANCELED.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa cuya suscripción se cancela. Decide si se da de baja lo de la persona o lo de la organización entera, así que se valida que el usuario autenticado pertenezca a ella.',
    }),
    ApiResponse({
      status: 201,
      description:
        'Baja programada. La respuesta trae el estado (que sigue siendo ACTIVE), el plan, `cancelAtPeriodEnd: true` y la fecha efectiva de término.',
    }),
    ApiResponse({
      status: 400,
      description: 'Falta el header X-Account-Id de la cuenta activa.',
    }),
    ApiResponse({
      status: 403,
      description: 'No perteneces a la cuenta activa (X-Account-Id).',
    }),
    ApiResponse({
      status: 409,
      description:
        'No hay una suscripción activa que cancelar, o la cancelación ya estaba programada.',
    }),
    ApiResponse({
      status: 502,
      description:
        'El proveedor de pagos no respondió; no se modificó nada localmente.',
    }),
  );
}
