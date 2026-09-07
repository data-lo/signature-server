import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/**
 * `GET /api/v1/payments/subscription`
 *
 * La explicación del endpoint vive acá y no en un docblock del controller a propósito: ese
 * hueco lo toca también la rama que añade `billing-state`, y escribir los dos en el mismo sitio
 * garantiza un conflicto en cada mezcla. Acá nadie más escribe.
 *
 * `X-Account-Id` no es opcional ni decorativo: un usuario con cuenta personal y organización
 * tiene dos suscripciones distintas a la vez, y cuál se responde depende de en cuál esté
 * trabajando. Leerlo mal es justo lo que hacía la versión anterior, que resolvía la cuenta con
 * un `findOne` por `userId` y devolvía la primera membresía que saliera.
 */
export function ApiGetSubscriptionState() {
  return applyDecorators(
    ApiOperation({
      summary: 'Estado de suscripción de la cuenta activa',
      description:
        'Resuelve al propietario facturable de la cuenta activa (la cuenta personal, o la ORGANIZACIÓN completa si el contexto es una organización) y devuelve el estado de su suscripción leído de `billing_profiles`: si está vigente, el plan, el estado concreto y las fechas del periodo. ' +
        'La fuente es `billing_profiles` y NO `account_subscriptions`: aquella tabla se mantiene por compatibilidad pero no refleja la activación del pago, que hace el webhook `invoice.paid`. ' +
        'Es una consulta de sólo lectura: una cuenta que nunca ha contratado responde 200 con los campos vacíos, no 404.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa que se consulta. Un usuario con cuenta personal y organización tiene dos suscripciones distintas a la vez, así que decide cuál se responde; se valida que pertenezca a ella.',
    }),
    ApiResponse({
      status: 200,
      description:
        '`hasActiveSubscription` (`status = ACTIVE`), `planType`, `status`, `currentPeriodStart` y `currentPeriodEnd`.',
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
