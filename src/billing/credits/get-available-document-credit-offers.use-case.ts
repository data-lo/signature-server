import { Injectable, Logger } from '@nestjs/common';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { DocumentCreditOfferResponse } from './document-credit-offer.interface';

/**
 * Paquetes de documentos que la cuenta activa puede comprar HOY, según su plan vigente.
 *
 * **El plan decide el precio, no sólo la visibilidad.** La misma oferta vale distinto en Free,
 * Plus y Premium, y eso vive como filas distintas de `catalog_prices` con su `eligible_plan_type`.
 * Por eso esta consulta filtra por el plan del perfil resuelto en el servidor y nunca por nada que
 * llegue en la petición: es la mitad de la regla que impide comprar el paquete de Premium desde
 * una cuenta Free (la otra mitad la aplica el checkout, que vuelve a validar).
 *
 * **Devolver una lista vacía es una respuesta normal**, no un error: un plan al que todavía no le
 * han configurado paquetes es un estado corriente del catálogo, y la pantalla lo dibuja como "no
 * hay paquetes disponibles para tu plan".
 *
 * No crea perfil: es una consulta, y crear filas al mirar una pantalla convertiría un GET en algo
 * con efectos. Una cuenta sin perfil —o con un perfil sin plan— no tiene plan contra el que
 * comparar, así que no tiene ofertas.
 */
@Injectable()
export class GetAvailableDocumentCreditOffersUseCase {
  private readonly logger = new Logger(
    GetAvailableDocumentCreditOffersUseCase.name,
  );

  constructor(
    private readonly billingOwnerService: BillingOwnerService,
    private readonly billingCatalogService: BillingCatalogService,
  ) {}

  /**
   * Lista las ofertas de documentos compatibles con el plan de la cuenta activa.
   *
   * @param input - Usuario autenticado y cuenta activa (`X-Account-Id`), que juntos deciden a qué
   *   propietario facturable se le está preguntando.
   * @returns Las ofertas vendibles, de la más barata a la más cara; vacío si el plan no tiene
   *   ninguna configurada, si la cuenta no tiene perfil, o si su perfil no tiene plan.
   *
   * @throws {ForbiddenException} Si el usuario no pertenece a la cuenta activa (lo lanza
   *   `BillingOwnerService.resolveOwner`).
   *
   * @example
   * const ofertas = await useCase.execute({ userId: user.sub, accountId });
   * // [{ catalogPriceId: 'uuid', name: 'Documento adicional', documentsGranted: 1, ... }]
   */
  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<DocumentCreditOfferResponse[]> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    /**
     * Sin plan no hay tarifa que aplicar. No se cae a `free` por defecto —aunque hoy toda cuenta
     * nazca con perfil gratuito— por la misma razón que `GetBillingAccessUseCase` deja
     * `currentPlanType` en `null`: inventar un plan aquí ofrecería las tarifas de Free a una
     * cuenta cuyo estado real es "todavía no lo sé".
     */
    if (!profile?.currentPlanType) {
      this.logger.debug(
        `La cuenta ${input.accountId} no tiene plan vigente; no hay paquetes de documentos que ofrecer.`,
      );
      return [];
    }

    const prices =
      await this.billingCatalogService.findAvailableDocumentCreditPrices(
        profile.currentPlanType,
        owner,
      );

    /**
     * Una oferta sin precio publicado en Stripe no se puede llevar a Checkout: se ofrecería un
     * botón que revienta al pulsarlo. Se filtra acá y no en el catálogo porque allí la ausencia
     * es legítima —un importe administrado sólo en nuestra base—; lo que no es legítimo es
     * VENDERLA.
     */
    const vendibles = prices.filter((price) => Boolean(price.stripePriceId));

    if (vendibles.length !== prices.length) {
      this.logger.warn(
        `${prices.length - vendibles.length} paquete(s) del plan ${profile.currentPlanType} ` +
          'quedaron fuera por no tener stripe_price_id publicado.',
      );
    }

    return vendibles.map((price) => ({
      catalogPriceId: price.id,
      name: price.catalogItem.name,
      // `findAvailableDocumentCreditPrices` ya descarta los ítems sin paquete.
      documentsGranted: price.catalogItem.documentCreditPack!.documentsGranted,
      amount: price.amount,
      currency: price.currency,
      stripePriceId: price.stripePriceId,
    }));
  }
}
