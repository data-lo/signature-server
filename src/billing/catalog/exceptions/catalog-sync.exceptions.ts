import { InternalServerErrorException } from '@nestjs/common';

/**
 * Un producto de Stripe llegó marcado como plan (`metadata.catalogType = 'plan'`) sin
 * `metadata.planType` — el único dato que dice a qué fila de `plans` corresponde, porque esa
 * tabla usa `code` como llave primaria y no un UUID que se pudiera generar solo.
 *
 * 500 a propósito, no un log-y-seguir: sin el tipo de plan no hay forma de sincronizar el
 * producto sin adivinar, y Stripe reintenta la entrega durante varios días — tiempo de sobra
 * para corregir la metadata del producto en el dashboard sin perder el evento.
 */
export class MissingPlanTypeMetadataException extends InternalServerErrorException {
  constructor(stripeProductId: string) {
    super(
      `El producto de Stripe ${stripeProductId} está marcado como plan (metadata.catalogType='plan') pero no trae metadata.planType.`,
    );
  }
}

/**
 * Un precio de un producto marcado como paquete de documentos llegó sin `metadata.documentsGranted`
 * (ni en el precio ni en el producto). Cuántos documentos concede el paquete es justamente lo que
 * se vende: no hay valor por defecto razonable, y uno inventado se traduciría en saldo real
 * regalado o negado a quien pague.
 *
 * Mismo criterio que `MissingPlanTypeMetadataException`: 500 para que Stripe reintente mientras
 * se corrige la metadata.
 */
export class MissingDocumentPackMetadataException extends InternalServerErrorException {
  constructor(stripePriceId: string, field: string) {
    super(
      `El precio de Stripe ${stripePriceId} pertenece a un paquete de documentos (metadata.catalogType='document_pack') pero no trae metadata.${field}.`,
    );
  }
}

/**
 * La metadata restringe el paquete a un plan que no existe en `plans`. Guardarlo igual violaría
 * la llave foránea de `document_pack_offers.eligible_plan_code`; dejarlo en null convertiría una
 * oferta restringida en una para todo el mundo, que es peor que no sincronizarla.
 */
export class UnknownEligiblePlanMetadataException extends InternalServerErrorException {
  constructor(stripePriceId: string, planType: string) {
    super(
      `El precio de Stripe ${stripePriceId} declara metadata.eligiblePlanType='${planType}', que no corresponde a ningún plan local.`,
    );
  }
}
