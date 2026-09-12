import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsUUID } from 'class-validator';
import { MAX_DOCUMENT_CREDITS_PER_PURCHASE } from 'src/billing/credits/document-credit-quantity';

export class CreateDocumentCreditCheckoutDto {
  /**
   * El id LOCAL del precio (`catalog_prices.id`), no el de Stripe.
   *
   * Que viaje el nuestro y no el del proveedor es lo que permite validar la compra contra el
   * catálogo antes de tocar Stripe: con un `price_...` habría que preguntarle primero a Stripe
   * qué es, y el plan al que corresponde la oferta —`eligible_plan_type`— sólo existe de este
   * lado.
   *
   * `@IsUUID` rechaza de entrada lo que ni forma de id tiene, pero **no sustituye a nada**: el
   * caso de uso vuelve a comprobar que el precio exista, esté activo, sea un paquete de pago
   * único y corresponda al plan vigente de la cuenta.
   */
  @ApiProperty({
    example: '7f3c1f6e-2b4a-4c8d-9e15-0a1b2c3d4e5f',
    format: 'uuid',
    description:
      'Identificador del precio del catálogo local que devuelve GET /api/v1/payments/document-credit-offers.',
  })
  @IsUUID()
  catalogPriceId: string;

  /**
   * Unidades de la oferta que se compran en este Checkout.
   *
   * **El DTO sólo exige que llegue un número** —ni texto, ni `NaN`, ni ausente—. Que sea entero,
   * mayor que cero y no supere el máximo lo decide `assertValidDocumentCreditQuantity` dentro del
   * caso de uso, por dos motivos: la regla tiene que valer para cualquier llamador y no sólo para
   * HTTP, y su rechazo responde con `field: 'quantity'`, que es lo que deja al formulario pintar el
   * mensaje debajo del selector. Un rechazo de `ValidationPipe` llega como una lista de textos sin
   * decir de qué campo es.
   *
   * Sin `@Type(() => Number)` a propósito: el cliente manda un número en el JSON, y convertir un
   * `"5"` aquí escondería a un cliente que no está transformando lo que envía.
   */
  @ApiProperty({
    example: 5,
    type: 'integer',
    minimum: 1,
    maximum: MAX_DOCUMENT_CREDITS_PER_PURCHASE,
    description: `Unidades de la oferta que se compran. Entero entre 1 y ${MAX_DOCUMENT_CREDITS_PER_PURCHASE}; queda bloqueada en Stripe Checkout.`,
  })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'La cantidad debe ser un número.' },
  )
  quantity: number;
}
