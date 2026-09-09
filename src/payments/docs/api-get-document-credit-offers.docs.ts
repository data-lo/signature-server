import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/payments/document-credit-offers` */
export function ApiGetDocumentCreditOffers() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar los paquetes de documentos disponibles para la cuenta activa',
      description:
        'Devuelve los paquetes de documentos que se le pueden vender HOY a la cuenta activa, según su plan vigente. Todo sale del catálogo LOCAL (`catalog_items` + `document_credit_packs` + `catalog_prices`), sincronizado desde Stripe por webhook: ni el importe ni los documentos concedidos se consultan al proveedor en vivo. Se filtra por `catalog_price.eligible_plan_type = billing_profile.current_plan_type`, así que una cuenta Free no ve —ni puede comprar— el paquete de Premium. Requiere `X-Account-Id`: el plan es de la cuenta activa, no del usuario. Una lista vacía es una respuesta normal y significa que ese plan no tiene paquetes configurados.',
    }),
    ApiResponse({
      status: 200,
      description: 'Paquetes compatibles con el plan vigente, del más barato al más caro.',
    }),
    ApiResponse({
      status: 400,
      description: 'Falta el header X-Account-Id de la cuenta activa.',
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario no pertenece a la cuenta activa.',
    }),
  );
}
