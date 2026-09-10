import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogPriceEntity } from './catalog-price.entity';
import {
  DocumentCreditOfferNotAvailableException,
  SubscriptionPriceNotAvailableException,
} from '../exceptions/billing.exceptions';
import { CATALOG_ITEM_TYPE_ENUM } from '../enums/catalog-item-type.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import { CATALOG_SCOPE_SUBJECT_TYPE_ENUM } from '../enums/catalog-scope-subject-type.enum';
import { BillingOwner } from '../profiles/billing-owner.service';

/**
 * Consulta el catálogo comercial LOCAL (`catalog_items` + `catalog_prices`).
 *
 * Es el reemplazo, para el flujo de suscripción, de preguntarle el catálogo a Stripe en cada
 * compra (lo que sigue haciendo `GetPaymentServicesUseCase` para pintar las tarjetas). La razón
 * no es el ahorro de una llamada: es que el importe y los límites que se cobran tienen que salir
 * de una fila nuestra, versionada y auditable, y no de lo que el proveedor conteste en ese
 * instante. `plans.documents_included` —cuántos documentos concede el plan— no existe en
 * Stripe en absoluto, así que sin el catálogo local no habría de dónde sacarlo al facturar.
 */
@Injectable()
export class BillingCatalogService {
  private readonly logger = new Logger(BillingCatalogService.name);

  constructor(
    @InjectRepository(CatalogPriceEntity)
    private readonly catalogPriceRepository: Repository<CatalogPriceEntity>,
  ) {}

  /**
   * Busca un precio recurrente vendible por su `stripe_price_id`.
   *
   * **Por qué no hay una comprobación explícita de "es recurrente":** la recurrencia es
   * estructural, no un campo que validar. `catalog_prices.billing_mode=RECURRING` distingue una
   * suscripción de una compra única; ambas usan la misma tabla sin perder su semántica.
   *
   * @throws {SubscriptionPriceNotAvailableException} Si no existe, o si el precio o su plan
   *   están dados de baja, o si está fuera de su ventana de vigencia.
   */
  async findSellableRecurringPrice(
    stripePriceId: string,
    owner: BillingOwner,
  ): Promise<CatalogPriceEntity> {
    const price = await this.catalogPriceRepository.findOne({
      where: {
        stripePriceId,
        isActive: true,
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
      },
      relations: { catalogItem: { plan: true, scopes: true } },
      order: { effectiveFrom: 'DESC' },
    });

    if (!price) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId}, que no está en catalog_prices ` +
          '(no existe, está inactivo o es un precio de pago único).',
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    if (!price.catalogItem.isActive || !price.catalogItem.plan?.isActive) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId}, cuyo ítem o plan está dado de baja.`,
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    if (!this.isAvailableToOwner(price, owner)) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId} fuera del alcance del catálogo para el owner seleccionado.`,
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    if (!this.isInEffectiveWindow(price)) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId}, fuera de su ventana de vigencia ` +
          `(${price.effectiveFrom?.toISOString() ?? 'sin inicio'} → ${price.effectiveTo?.toISOString() ?? 'sin fin'}).`,
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    return price;
  }

  /**
   * Paquetes de documentos que se le pueden vender HOY a una cuenta con este plan.
   *
   * **El plan no es un filtro cosmético: es el precio.** La misma oferta —"1 documento
   * adicional"— vale distinto según el plan contratado, y eso se modela como filas distintas de
   * `catalog_prices` con `eligible_plan_type` propio. Por eso se filtra por igualdad estricta y
   * NO se incluyen los precios con `eligible_plan_type` nulo: un precio sin plan sería vendible a
   * todos y rompería justamente la tabla de tarifas por plan que la historia pide.
   *
   * Devuelve una lista, que puede estar vacía: un plan sin paquetes configurados es un estado
   * normal del catálogo —nadie los ha dado de alta todavía— y no un error que deba reventar la
   * pantalla de suscripciones.
   *
   * @param planType - Plan vigente de la cuenta (`billing_profiles.current_plan_type`).
   * @param owner - Propietario facturable, para respetar los scopes del ítem de catálogo.
   * @returns Los precios vendibles con su ítem y su paquete cargados, del más barato al más caro.
   *
   * @example
   * const ofertas = await catalog.findAvailableDocumentCreditPrices('free', owner);
   * ofertas[0].catalogItem.documentCreditPack.documentsGranted; // 1
   */
  async findAvailableDocumentCreditPrices(
    planType: string,
    owner: BillingOwner,
  ): Promise<CatalogPriceEntity[]> {
    const prices = await this.catalogPriceRepository.find({
      where: {
        isActive: true,
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME,
        eligiblePlanType: planType,
        catalogItem: {
          isActive: true,
          itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
        },
      },
      relations: {
        catalogItem: { documentCreditPack: true, scopes: true },
      },
      /** Del más barato al más caro: es el orden en que se ofrecen. */
      order: { amount: 'ASC' },
    });

    return prices.filter(
      (price) =>
        /**
         * Un ítem marcado como paquete pero sin su fila en `document_credit_packs` no dice
         * cuántos documentos concede. Se descarta en vez de ofrecerlo con un cero inventado: una
         * oferta que no acredita nada es peor que una oferta que no aparece.
         */
        Boolean(price.catalogItem.documentCreditPack) &&
        this.isInEffectiveWindow(price) &&
        this.isAvailableToOwner(price, owner),
    );
  }

  /**
   * Resuelve UN paquete de documentos comprobando que se le pueda vender a esta cuenta.
   *
   * **Es la validación que impide comprar un paquete de otro plan manipulando el
   * `catalogPriceId`.** No se confía en que el frontend haya pedido antes la lista: cada
   * comprobación de `findAvailableDocumentCreditPrices` se repite aquí sobre la fila concreta,
   * porque entre listar y comprar puede cambiar el catálogo — y porque el `catalogPriceId` que
   * llega es, literalmente, un dato del cliente.
   *
   * @param catalogPriceId - Id del precio del catálogo local que se quiere comprar.
   * @param planType - Plan vigente de la cuenta.
   * @param owner - Propietario facturable, para respetar los scopes del ítem.
   * @returns El precio, con su ítem y su paquete cargados.
   *
   * @throws {DocumentCreditOfferNotAvailableException} Si no existe, está inactivo, no es un
   *   paquete de documentos, no es de pago único, es de otro plan, está fuera de su ventana de
   *   vigencia, queda fuera del alcance del propietario o no tiene paquete asociado.
   *
   * @example
   * const precio = await catalog.findSellableDocumentCreditPrice(dto.catalogPriceId, 'free', owner);
   */
  async findSellableDocumentCreditPrice(
    catalogPriceId: string,
    planType: string,
    owner: BillingOwner,
  ): Promise<CatalogPriceEntity> {
    const price = await this.catalogPriceRepository.findOne({
      where: { id: catalogPriceId },
      relations: {
        catalogItem: { documentCreditPack: true, scopes: true },
      },
    });

    const rechazar = (motivo: string): never => {
      this.logger.warn(
        `Compra de créditos rechazada para el precio ${catalogPriceId} (plan ${planType}): ${motivo}.`,
      );
      throw new DocumentCreditOfferNotAvailableException();
    };

    if (!price) {
      return rechazar('no existe en catalog_prices');
    }

    if (!price.isActive || !price.catalogItem.isActive) {
      return rechazar('el precio o su ítem están dados de baja');
    }

    if (
      price.catalogItem.itemType !== CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT
    ) {
      return rechazar('el ítem no es un paquete de documentos');
    }

    if (price.billingMode !== CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME) {
      return rechazar('el precio no es de pago único');
    }

    /**
     * El corazón de la regla: no se puede comprar el paquete de Premium desde una cuenta Free.
     * Se compara contra el plan VIGENTE del perfil, resuelto en el servidor, nunca contra nada
     * que venga en la petición.
     */
    if (price.eligiblePlanType !== planType) {
      return rechazar(
        `el paquete es del plan ${price.eligiblePlanType ?? 'sin plan'} y la cuenta está en ${planType}`,
      );
    }

    if (!price.catalogItem.documentCreditPack) {
      return rechazar('el ítem no declara cuántos documentos concede');
    }

    if (!this.isInEffectiveWindow(price)) {
      return rechazar('está fuera de su ventana de vigencia');
    }

    if (!this.isAvailableToOwner(price, owner)) {
      return rechazar('queda fuera del alcance del catálogo para este propietario');
    }

    return price;
  }

  /**
   * Como se resuelve el plan al FACTURAR (no al comprar): sin validar vigencia ni estado.
   *
   * Es deliberado que sea más laxo que `findSellableRecurringPrice`. Aquí ya hubo un cobro real:
   * si el plan se archivó o el precio caducó entre la contratación y la renovación, el cliente
   * pagó igual y le tocan sus documentos. Rechazar la factura por eso le quitaría lo que compró
   * y dejaría el evento reintentándose para siempre.
   */
  async findPriceForInvoice(
    stripePriceId: string,
  ): Promise<CatalogPriceEntity | null> {
    return this.catalogPriceRepository.findOne({
      where: { stripePriceId },
      relations: { catalogItem: { plan: true } },
      order: { effectiveFrom: 'DESC' },
    });
  }

  private isInEffectiveWindow(price: CatalogPriceEntity): boolean {
    const now = Date.now();

    if (price.effectiveFrom && price.effectiveFrom.getTime() > now) {
      return false;
    }

    if (price.effectiveTo && price.effectiveTo.getTime() <= now) {
      return false;
    }

    return true;
  }

  /** Sin scopes es global; con scopes debe existir una coincidencia exacta con el dueño facturable. */
  private isAvailableToOwner(
    price: CatalogPriceEntity,
    owner: BillingOwner,
  ): boolean {
    const scopes = price.catalogItem.scopes ?? [];
    if (!scopes.length) {
      return true;
    }

    return scopes.some(
      (scope) =>
        (scope.subjectType === CATALOG_SCOPE_SUBJECT_TYPE_ENUM.ORGANIZATION &&
          scope.subjectId === owner.organizationId) ||
        (scope.subjectType ===
          CATALOG_SCOPE_SUBJECT_TYPE_ENUM.PERSONAL_ACCOUNT &&
          scope.subjectId === owner.personalAccountId),
    );
  }
}
