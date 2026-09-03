import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/payments/services` */
export function ApiGetPaymentServices() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar el catálogo público de planes',
      description:
        "Devuelve los planes activos del proveedor de pagos —sus productos con metadata catalogType='plan' y visibility='true'— con lo necesario para pintar las tarjetas: nombre, descripción, importe, moneda, periodicidad, priceId e imagen. La respuesta se cachea 10 minutos, así que un cambio hecho en el dashboard del proveedor puede tardar ese tiempo en verse. El plan gratuito no aparece: no se administra en el proveedor. NO crea ninguna sesión de pago: la URL de Checkout se genera al comprar.",
    }),
    ApiResponse({ status: 200, description: 'Catálogo público de planes.' }),
    ApiResponse({
      status: 502,
      description: 'El proveedor de pagos no respondió.',
    }),
  );
}
