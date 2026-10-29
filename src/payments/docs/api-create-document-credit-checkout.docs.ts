import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MAX_DOCUMENT_CREDITS_PER_PURCHASE } from 'src/billing/credits/document-credit-quantity';

/** `POST /api/v1/payments/document-credits/checkout` */
export function ApiCreateDocumentCreditCheckout() {
  return applyDecorators(
    ApiOperation({
      summary: 'Abrir el Checkout para comprar documentos sueltos',
      description: `Crea una sesión de Stripe Checkout en modo \`payment\` (cobro único) por \`quantity\` unidades del paquete indicado y registra la orden local en \`PENDING\` —con la cantidad y el importe total esperado (precio unitario del catálogo × \`quantity\`)— antes de responder. Un solo Price de Stripe sirve para cualquier cantidad: no se crea un precio por cantidad, y la cantidad queda **bloqueada** en Checkout (\`adjustable_quantity\` desactivado). \`quantity\` debe ser un entero entre 1 y ${MAX_DOCUMENT_CREDITS_PER_PURCHASE}. **No crea ni modifica ninguna suscripción**, y por eso se permite tanto con plan activo como con la baja ya programada. El \`catalogPriceId\` se vuelve a validar entero contra el catálogo —que exista, esté activo, sea un paquete de documentos, sea de pago único y corresponda al plan vigente de la cuenta— así que manipularlo para comprar el paquete de otro plan responde 404. El importe NUNCA sale de la petición. El saldo NO se acredita aquí: lo hace el webhook \`checkout.session.completed\`, que lee de Stripe la cantidad realmente pagada, la concilia con la orden y acredita \`documentsGranted × cantidad pagada\`.`,
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión creada; devuelve la URL hospedada de Stripe.',
    }),
    ApiResponse({
      status: 400,
      description: `Falta el header X-Account-Id, el catalogPriceId no es un UUID o quantity no es un número. También cuando quantity no es un entero entre 1 y ${MAX_DOCUMENT_CREDITS_PER_PURCHASE}; en ese caso la respuesta incluye \`field: 'quantity'\` y \`maxQuantity\`.`,
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario no pertenece a la cuenta activa.',
    }),
    ApiResponse({
      status: 404,
      description:
        'El paquete no existe, está dado de baja, no es de pago único o es de otro plan.',
    }),
    ApiResponse({
      status: 502,
      description: 'El proveedor de pagos no respondió.',
    }),
  );
}
