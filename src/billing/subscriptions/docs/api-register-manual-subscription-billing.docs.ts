import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';

/** `POST /api/v1/internal/billing/subscription-periods` */
export function ApiRegisterManualSubscriptionBilling() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiOperation({
      summary: 'Registrar un periodo cobrado fuera de Stripe (uso interno)',
      description:
        'Da de alta un periodo pagado por transferencia, depósito o factura emitida por administración: acredita los documentos del plan, escribe el renglón en el historial de facturación con `source=MANUAL` y deja el perfil ACTIVE con el plan y el periodo vigentes. ' +
        'NO crea nada en Stripe —ni cliente, ni suscripción, ni factura, ni pago—: el dinero ya entró por otra vía. ' +
        'El perfil queda en `billing_source=MANUAL`, así que el cron de expiración lo devolverá al plan Free cuando llegue `periodEnd` si para entonces no se ha registrado otro periodo. ' +
        'Es idempotente por `externalReference`: reenviar el mismo folio para el mismo perfil responde 201 con `alreadyRegistered: true` y no acredita documentos por segunda vez.',
    }),
    ApiResponse({
      status: 201,
      description:
        'Periodo registrado. `alreadyRegistered: true` significa que ese folio ya estaba dado de alta y no se escribió nada.',
    }),
    ApiResponse({
      status: 400,
      description:
        'Datos incoherentes: importe negativo, moneda que no es un ISO de tres letras, periodo que termina antes de empezar, o falta de folio y de usuario que lo registre.',
    }),
    ApiResponse({
      status: 401,
      description: 'Falta la API Key interna (`x-api-key`).',
    }),
    ApiResponse({
      status: 404,
      description: 'El perfil de facturación o el plan indicados no existen.',
    }),
  );
}
