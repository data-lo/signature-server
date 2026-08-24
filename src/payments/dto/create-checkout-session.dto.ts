import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Formato de un identificador de precio de Stripe. No sustituye a la validación real —el caso
 * de uso comprueba que el precio esté en el catálogo activo—, pero rechaza de entrada lo que
 * ni siquiera tiene forma de precio, sin gastar una llamada al proveedor.
 */
const STRIPE_PRICE_ID = /^price_[A-Za-z0-9]+$/;

export class CreateCheckoutSessionDto {
  @ApiProperty({
    example: 'price_1QAbCdEfGhIjKlMn',
    description:
      'Identificador del precio de Stripe que devuelve GET /api/v1/payments/services. Debe pertenecer a un servicio activo del catálogo.',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  @Matches(STRIPE_PRICE_ID, {
    message: 'priceId debe ser un identificador de precio de Stripe válido',
  })
  priceId: string;
}
