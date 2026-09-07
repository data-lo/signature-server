import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/payments/subscription/resume` */
export function ApiResumeSubscription() {
  return applyDecorators(
    ApiOperation({
      summary: 'Deshacer una baja programada',
      description:
        'Le pide a Stripe que vuelva a renovar la suscripción (`cancel_at_period_end: false`) y quita la marca del perfil. Es la operación inversa de `POST /payments/subscription/cancel`. ' +
        'Sólo sirve mientras el periodo siga vigente: una vez que Stripe da de baja la suscripción, el perfil pasa a CANCELED y desde ahí el camino es contratar de nuevo. ' +
        'La base local se escribe sólo después de que Stripe confirme, y el webhook `customer.subscription.updated` vuelve a sincronizar el valor.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa cuya suscripción se reanuda. Se valida que el usuario autenticado pertenezca a ella.',
    }),
    ApiResponse({
      status: 201,
      description:
        'Suscripción reanudada. La respuesta trae `cancelAtPeriodEnd: false` y la fecha en que se cobrará la próxima renovación.',
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
        'No hay una suscripción activa, o no tenía ninguna cancelación programada que deshacer.',
    }),
    ApiResponse({
      status: 502,
      description:
        'El proveedor de pagos no respondió; no se modificó nada localmente.',
    }),
  );
}
