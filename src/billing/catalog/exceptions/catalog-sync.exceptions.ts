import { InternalServerErrorException } from '@nestjs/common';

/**
 * Un producto de Stripe llegó marcado como plan (`metadata.catalogType = 'plan'`) sin
 * `metadata.planCode` — el único dato que dice a qué fila de `plans` corresponde, porque esa
 * tabla usa `code` como llave primaria y no un UUID que se pudiera generar solo.
 *
 * 500 a propósito, no un log-y-seguir: sin el código no hay forma de sincronizar el producto sin
 * adivinar, y Stripe reintenta la entrega durante varios días — tiempo de sobra para corregir la
 * metadata del producto en el dashboard sin perder el evento.
 */
export class MissingPlanCodeMetadataException extends InternalServerErrorException {
  constructor(stripeProductId: string) {
    super(
      `El producto de Stripe ${stripeProductId} está marcado como plan (metadata.catalogType='plan') pero no trae metadata.planCode.`,
    );
  }
}
