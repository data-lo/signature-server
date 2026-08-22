import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

/** `GET /stripe/subscription` — estado de suscripción de la cuenta autenticada. */
export function ApiGetSubscriptionState() {
  return applyDecorators(
    ApiOperation({ summary: 'Estado de suscripción de la cuenta actual' }),
  );
}
