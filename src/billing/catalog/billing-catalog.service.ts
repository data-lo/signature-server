import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogPriceEntity } from './catalog-price.entity';
import { SubscriptionPriceNotAvailableException } from '../exceptions/billing.exceptions';
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
