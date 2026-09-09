import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

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
}
