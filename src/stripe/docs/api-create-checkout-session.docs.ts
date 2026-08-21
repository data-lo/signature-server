import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

/** `POST /stripe/checkout/session` — alta de una Checkout Session en modo suscripción. */
export function ApiCreateCheckoutSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear sesión de Checkout',
      description:
        'Crea (o reutiliza) el customer de Stripe de la cuenta y genera una Checkout Session en modo suscripción.',
    }),
  );
}
