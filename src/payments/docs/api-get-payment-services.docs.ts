import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/payments/services` */
export function ApiGetPaymentServices() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar el catálogo de servicios disponibles',
      description:
        'Devuelve los servicios activos del proveedor de pagos con lo necesario para pintar las tarjetas: nombre, descripción, importe, moneda, periodicidad, priceId e imagen. NO crea ninguna sesión de pago: la URL de Checkout se genera al comprar.',
    }),
    ApiResponse({ status: 200, description: 'Catálogo de servicios activos.' }),
    ApiResponse({
      status: 502,
      description: 'El proveedor de pagos no respondió.',
    }),
  );
}
