import { Injectable, Logger } from '@nestjs/common';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { DocumentCreditOfferResponse } from './document-credit-offer.interface';

/**
 * Paquetes de documentos que la cuenta activa puede comprar HOY, según su plan vigente.
 *
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable, comprobando la membresía en la cuenta activa.
 * 2. Busca su `billing_profile`. Sin perfil, o sin plan vigente, no hay ofertas.
 * 3. Consulta el catálogo por `eligible_plan_type` igual al plan del perfil.
 * 4. Descarta las ofertas sin `stripe_price_id`: no se pueden llevar a Checkout.
 *
 * **El plan decide el precio, no sólo la visibilidad.** La misma oferta vale distinto en Free,
 * Plus y Premium, y eso vive como filas distintas de `catalog_prices`. Por eso se filtra por el
 * plan del perfil resuelto en el servidor y nunca por nada que llegue en la petición: es la mitad
 * de la regla que impide comprar el paquete de Premium desde una cuenta Free — la otra la aplica
 * el checkout, que vuelve a validar.
 *
 * **Una lista vacía es una respuesta normal**, no un error: un plan al que todavía no le han
 * configurado paquetes es un estado corriente del catálogo.
 *
 * No crea perfil: crear filas al mirar una pantalla convertiría un GET en algo con efectos.
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
   * Ejecuta el caso de uso.
   *
   * @param input Usuario autenticado y cuenta activa, que juntos deciden a qué propietario
   *   facturable se le está preguntando.
   * @returns Las ofertas vendibles, de la más barata a la más cara; vacío si el plan no tiene
   *   ninguna configurada, si la cuenta no tiene perfil, o si su perfil no tiene plan.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
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

    // No se cae a `free` por defecto: inventar un plan ofrecería tarifas por un estado desconocido.
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

    // En el catálogo la ausencia es legítima; lo que no lo es es ofrecer la oferta en venta.
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
