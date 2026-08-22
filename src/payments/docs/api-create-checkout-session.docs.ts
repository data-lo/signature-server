import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/payments/checkout-sessions` */
export function ApiCreateCheckoutSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear una sesión de Checkout para un servicio',
      description:
        'Valida que el precio pertenezca al catálogo activo y abre una sesión de Checkout, devolviendo su URL temporal. Al terminar, Stripe regresa al usuario a /dashboard/subscriptions con `payment=success` o `payment=cancel`; el pago lo confirma el webhook firmado, no ese retorno.',
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión creada; la respuesta trae la URL de Checkout.',
    }),
    ApiResponse({
      status: 404,
      description: 'El precio no pertenece a ningún servicio activo.',
    }),
    ApiResponse({
      status: 502,
      description: 'El proveedor de pagos no respondió.',
    }),
  );
}
