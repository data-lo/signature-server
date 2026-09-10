import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/payments/document-credits/checkout` */
export function ApiCreateDocumentCreditCheckout() {
  return applyDecorators(
    ApiOperation({
      summary: 'Abrir el Checkout para comprar un paquete de documentos',
      description:
        'Crea una sesión de Stripe Checkout en modo `payment` (cobro único) para el paquete indicado y registra la orden local en `PENDING` antes de responder. **No crea ni modifica ninguna suscripción**, y por eso se permite tanto con plan activo como con la baja ya programada: comprar documentos de más es justamente lo que hace quien tiene plan vigente. El `catalogPriceId` se vuelve a validar entero contra el catálogo —que exista, esté activo, sea un paquete de documentos, sea de pago único y corresponda al plan vigente de la cuenta— así que manipularlo para comprar el paquete de otro plan responde 404. El saldo NO se acredita aquí: lo hace el webhook `checkout.session.completed` cuando Stripe confirma el pago.',
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión creada; devuelve la URL hospedada de Stripe.',
    }),
    ApiResponse({
      status: 400,
      description: 'Falta el header X-Account-Id, o el catalogPriceId no es un UUID.',
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
