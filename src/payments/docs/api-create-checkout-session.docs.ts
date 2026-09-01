import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/payments/checkout-sessions` */
export function ApiCreateCheckoutSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Contratar un plan recurrente para la cuenta activa',
      description:
        'Resuelve al propietario facturable de la cuenta activa (la cuenta personal, o la ORGANIZACIÓN completa si el contexto es una organización — los miembros comparten un solo perfil y un solo saldo), crea o recupera su perfil de facturación, valida que el precio sea un plan recurrente vendible del catálogo local, abre la sesión de Checkout en modo `subscription` y registra la orden local en estado PENDING. ' +
        'Devuelve la URL temporal de Checkout. Al terminar, Stripe regresa al usuario a /dashboard/subscriptions con `payment=success` o `payment=cancel`: ese retorno NO confirma el pago. La suscripción se activa y los documentos del periodo se conceden cuando llega el webhook firmado `invoice.paid`.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa desde la que se contrata. Determina a quién se le factura y qué perfil recibe el saldo, así que se valida que el usuario autenticado pertenezca a ella.',
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión creada; la respuesta trae la URL de Checkout.',
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
      status: 404,
      description:
        'El precio no corresponde a ningún plan recurrente vendible del catálogo local.',
    }),
    ApiResponse({
      status: 502,
      description: 'El proveedor de pagos no respondió.',
    }),
  );
}
