import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { PlanEntity } from './plan.entity';
import { PlanPriceEntity } from './plan-price.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_TYPE_ENUM } from '../enums/catalog-type.enum';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import {
  MissingDocumentPackMetadataException,
  MissingPlanTypeMetadataException,
  UnknownEligiblePlanMetadataException,
} from './exceptions/catalog-sync.exceptions';

/**
 * Límites conservadores para un plan que `product.created` crea SIN fila local previa: nadie lo
 * dio de alta a mano con sus límites comerciales reales antes de configurarlo en Stripe. No
 * bloquea la sincronización (el webhook no puede saber cuáles deberían ser los límites reales,
 * y rechazar el evento no lo arreglaría — reintentar no cambia la metadata), pero tampoco lo deja
 * vendible con un límite generoso por accidente: 1 documento al mes y sin firma avanzada es lo
 * bastante restrictivo para que sea evidente en cuanto alguien lo use, y `active` sigue el valor
 * real de Stripe, así que el plan queda visible/comprable de inmediato si así se configuró.
 */
const DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT = 1;

/**
 * Periodicidades de Stripe que este catálogo sabe facturar. `day` y `week` existen en Stripe pero
 * no en `BILLING_INTERVAL_ENUM`: un precio así no se puede guardar en `plan_prices` sin inventarle
 * una equivalencia, así que se ignora con un aviso en vez de traducirlo mal.
 */
const SUPPORTED_INTERVALS: Record<string, BILLING_INTERVAL_ENUM> = {
  month: BILLING_INTERVAL_ENUM.MONTH,
  year: BILLING_INTERVAL_ENUM.YEAR,
};

/**
 * Sincroniza el catálogo comercial local (`plans`, `plan_prices`, `document_pack_offers`) con los
 * productos y precios de Stripe.
 *
 * Vive separado de `StripeWebhookService`, que sólo enruta el evento ya autenticado, y de
 * `StripePaymentService`, que atiende el checkout: esto no es efecto de un pago sino mantenimiento
 * de catálogo, y un admin puede renombrar o desactivar un producto en el dashboard sin que nadie
 * compre nada.
 *
 * **Enruta por la metadata del PRODUCTO, no por nombre**: un producto de Stripe no dice si es plan o
 * paquete (ver `CATALOG_TYPE_ENUM`). Los eventos de precio se enrutan igual, y por eso
 * `syncPriceUpserted` lo recibe ya resuelto: el payload de `price.*` sólo trae su id.
 *
 * **Nunca toca** `monthlyDocumentLimit`, `allowSimpleSignature` ni `allowAdvancedSignature`: son
 * configuración comercial interna que Stripe no conoce, y sincronizarlos sobrescribiría con nada la
 * configuración real cada vez que alguien sólo quisiera renombrar el plan.
 *
 * **Nada se borra**: ni `product.deleted` ni un cambio de precio destruyen filas, se marcan
 * inactivas. `checkout_orders` apunta a ellas con `ON DELETE RESTRICT`, así que el importe cobrado
 * tiene que seguir existiendo tal cual para las facturas y órdenes históricas.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
    @InjectRepository(PlanPriceEntity)
    private readonly planPriceRepository: Repository<PlanPriceEntity>,
    @InjectRepository(DocumentPackOfferEntity)
    private readonly documentPackOfferRepository: Repository<DocumentPackOfferEntity>,
  ) { }

  async syncProductUpserted(product: Stripe.Product): Promise<void> {
    const catalogType = this.resolveCatalogType(product);

    switch (catalogType) {
      case CATALOG_TYPE_ENUM.PLAN:
        await this.upsertPlan(product);
        return;
      case CATALOG_TYPE_ENUM.DOCUMENT_PACK:
        await this.syncDocumentPackProduct(product);
        return;
      default:
        return;
    }
  }
  async syncProductDeleted(product: Stripe.Product): Promise<void> {
    const catalogType = this.resolveCatalogType(product);

    switch (catalogType) {
      case CATALOG_TYPE_ENUM.PLAN:
        await this.deactivateByStripeProductId(
          this.planRepository,
          product.id,
          'plan',
        );
        return;
      case CATALOG_TYPE_ENUM.DOCUMENT_PACK:
        await this.deactivateByStripeProductId(
          this.documentPackOfferRepository,
          product.id,
          'paquete de documentos',
        );
        return;
      default:
        return;
    }
  }

  /**
   * `price.created` y `price.updated`, enrutados por el catálogo al que pertenece su producto.
   *
   * @param product Producto del precio, ya resuelto por quien recibe el evento: el payload de
   *   `price.*` trae `product` como id, y la metadata que decide el enrutamiento vive ahí.
   */
  async syncPriceUpserted(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<void> {
    const catalogType = this.resolveCatalogType(product);

    switch (catalogType) {
      case CATALOG_TYPE_ENUM.PLAN:
        await this.upsertPlanPrice(price, product);
        return;
      case CATALOG_TYPE_ENUM.DOCUMENT_PACK:
        await this.upsertDocumentPackPrice(price, product);
        return;
      default:
        return;
    }
  }

  private resolveCatalogType(
    product: Stripe.Product,
  ): CATALOG_TYPE_ENUM | null {
    const raw = product.metadata?.catalogType?.trim().toLowerCase();

    if (!raw) {
      // Caso común, no un problema: la mayoría de los productos de una cuenta de Stripe no son
      // necesariamente parte de este catálogo. Un log aquí sería puro ruido.
      return null;
    }

    const match = Object.values(CATALOG_TYPE_ENUM).find(
      (value) => value === raw,
    );
    if (!match) {
      this.logger.warn(
        `Producto de Stripe ${product.id} con metadata.catalogType='${raw}' no reconocida ` +
        `(se esperaba '${CATALOG_TYPE_ENUM.PLAN}' o '${CATALOG_TYPE_ENUM.DOCUMENT_PACK}'); se ignora.`,
      );
      return null;
    }

    return match;
  }

  private resolvePlanType(product: Stripe.Product): string | null {
    return (
      product.metadata?.planType?.trim() ||
      product.metadata?.planCode?.trim() ||
      null
    );
  }

  private resolveDocumentsIncluded(product: Stripe.Product): number | null {
    const raw = product.metadata?.documentsIncluded?.trim();
    const value = Number(raw);

    return Number.isInteger(value) && value > 0
      ? value
      : null;
  }

  private async upsertPlan(product: Stripe.Product): Promise<PlanEntity> {
    const planType = this.resolvePlanType(product);

    if (!planType) {
      throw new MissingPlanTypeMetadataException(product.id);
    }

    let plan = await this.planRepository.findOne({
      where: { stripeProductId: product.id },
    });

    if (!plan) {
      plan = await this.planRepository.findOne({ where: { planType } });
    }

    const documentsIncluded = this.resolveDocumentsIncluded(product);

    if (plan) {
      plan.name = product.name;
      plan.isActive = product.active;
      plan.stripeProductId = product.id;
      if (documentsIncluded !== null) {
        plan.documentsIncluded = documentsIncluded;
      }
      return this.planRepository.save(plan);
    }

    this.logger.warn(
      `Creando el plan '${planType}' a partir del producto de Stripe ${product.id} SIN ` +
      'configuración comercial local previa.',
    );

    const created = this.planRepository.create({
      planType,
      name: product.name,
      isActive: product.active,
      creationSource: PLAN_CREATION_SOURCE_ENUM.STRIPE,
      stripeProductId: product.id,
      documentsIncluded:
        documentsIncluded ?? DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT,
    });
    return this.planRepository.save(created);
  }

  /**
   * Sincroniza de un producto de paquete sólo lo comercial —nombre y estado— sobre TODAS sus
   * ofertas. Un mismo producto puede tener varias filas, una por plan elegible y precio, y el
   * nombre del producto es el de todas ellas.
   *
   * A diferencia de `upsertPlan`, esto NUNCA crea una fila: `documentsGranted`, `stripePriceId`,
   * `amount` y `currency` son NOT NULL y son datos del PRECIO, que un evento `product.*` no trae.
   * La fila la crea el evento del precio, que sí los tiene.
   */
  private async syncDocumentPackProduct(
    product: Stripe.Product,
  ): Promise<void> {
    const result = await this.documentPackOfferRepository.update(
      { stripeProductId: product.id },
      { name: product.name, active: product.active },
    );

    if (!result.affected) {
      this.logger.warn(
        `Producto de Stripe ${product.id} (metadata.catalogType='document_pack') sin ningún ` +
        'document_pack_offer local vinculado. No se crea uno nuevo: faltan datos del precio ' +
        '(documentsGranted/amount/currency/stripePriceId) que este evento no trae. Llegarán con ' +
        'el price.created del paquete.',
      );
    }
  }

  /**
   * Da de alta o actualiza el precio de un plan: una fila de `plan_prices` por `stripe_price_id`.
   *
   * Toda modificación comercial crea una versión local. Aunque Stripe normalmente publica un
   * nuevo `price_...` para un importe nuevo, no dependemos de ese detalle: si llega el mismo id
   * con monto, moneda o periodicidad diferentes, cerramos la versión activa e insertamos otra.
   * Esto preserva lo que referencian `checkout_orders.plan_price_id` y permite auditar precios.
   */
  private async upsertPlanPrice(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<void> {
    const interval = this.resolveInterval(price);
    if (!interval) {
      return;
    }

    if (price.unit_amount == null) {
      this.logger.warn(
        `El precio ${price.id} del plan ${product.id} no tiene unit_amount (precio por tramos); no se sincroniza.`,
      );
      return;
    }

    const plan = await this.upsertPlan(product);

    const activeVersion = await this.planPriceRepository.findOne({
      where: { stripePriceId: price.id, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });

    if (!price.active) {
      if (activeVersion) {
        activeVersion.isActive = false;
        activeVersion.effectiveTo = activeVersion.effectiveTo ?? new Date();
        await this.planPriceRepository.save(activeVersion);
        this.logger.log(
          `Versión activa del precio de Stripe ${price.id} cerrada en plan_prices.`,
        );
        return;
      }

      const latestVersion = await this.planPriceRepository.findOne({
        where: { stripePriceId: price.id },
        order: { effectiveFrom: 'DESC' },
      });
      if (latestVersion) {
        this.logger.log(
          `El precio de Stripe ${price.id} ya no tiene una versión activa; no se duplica.`,
        );
        return;
      }
    } else if (
      activeVersion &&
      this.hasSamePricing(activeVersion, plan.planType, price, interval)
    ) {
      this.logger.log(
        `Precio de Stripe ${price.id} sin cambios comerciales; se conserva su versión activa.`,
      );
      return;
    }

    const now = new Date();
    if (activeVersion) {
      activeVersion.isActive = false;
      activeVersion.effectiveTo = activeVersion.effectiveTo ?? now;
      await this.planPriceRepository.save(activeVersion);
      this.logger.log(
        `Versión anterior del precio de Stripe ${price.id} cerrada para crear una nueva.`,
      );
    }

    this.logger.log(
      `Se creará una versión local del precio de Stripe ${price.id} para el plan ${plan.planType}.`,
    );

    if (price.active) {
      await this.supersedePreviousPlanPrices(plan.planType, price, interval, now);
    }

    const created = this.planPriceRepository.create({
      planType: plan.planType,
      stripePriceId: price.id,
      amount: price.unit_amount,
      currency: price.currency,
      interval,
      intervalCount: price.recurring?.interval_count ?? 1,
      isActive: price.active,
      effectiveFrom: now,
      effectiveTo: null,
    });
    await this.planPriceRepository.save(created);
    this.logger.log(
      `Precio de Stripe ${price.id} creado en plan_prices para el plan ${plan.planType}.`,
    );
  }

  private hasSamePricing(
    version: PlanPriceEntity,
    planType: string,
    price: Stripe.Price,
    interval: BILLING_INTERVAL_ENUM,
  ): boolean {
    return (
      version.planType === planType &&
      version.amount === price.unit_amount &&
      version.currency === price.currency &&
      version.interval === interval &&
      version.intervalCount === (price.recurring?.interval_count ?? 1)
    );
  }

  /**
   * Cierra los precios vigentes a los que éste releva: mismo plan, misma moneda y misma
   * periodicidad. La comparación es tan estrecha a propósito — el precio mensual y el anual del
   * mismo plan conviven, igual que el mismo plan en dos monedas, y desactivar uno al publicar el
   * otro dejaría al plan sin una de sus dos formas de compra.
   */
  private async supersedePreviousPlanPrices(
    planType: string,
    price: Stripe.Price,
    interval: BILLING_INTERVAL_ENUM,
    supersededAt: Date,
  ): Promise<void> {
    await this.planPriceRepository.update(
      {
        planType,
        currency: price.currency,
        interval,
        intervalCount: price.recurring?.interval_count ?? 1,
        isActive: true,
      },
      { isActive: false, effectiveTo: supersededAt },
    );
  }

  /**
   * Da de alta o actualiza el precio de un paquete de documentos: una fila de
   * `document_pack_offers` por `stripe_price_id`.
   *
   * La fila —y no el producto— es la unidad del catálogo, porque el mismo paquete se vende a
   * distinto importe según el plan del comprador (`eligiblePlanType`) y en distintos tamaños
   * (`documentsGranted`), todos compartiendo `stripe_product_id`.
   *
   * Por eso un precio nuevo NO releva a los anteriores, al revés que en los planes: dos precios
   * activos del mismo producto suelen ser dos ofertas legítimas. Quien las da de baja es Stripe, al
   * archivarlas.
   */
  private async upsertDocumentPackPrice(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<void> {
    if (price.unit_amount == null) {
      this.logger.warn(
        `El precio ${price.id} del paquete ${product.id} no tiene unit_amount (precio por tramos); no se sincroniza.`,
      );
      return;
    }

    const documentsGranted = this.resolveDocumentsGranted(price, product);
    const eligiblePlanType = await this.resolveEligiblePlanType(price, product);

    const existing = await this.documentPackOfferRepository.findOne({
      where: { stripePriceId: price.id },
    });

    const offer =
      existing ??
      this.documentPackOfferRepository.create({ stripePriceId: price.id });

    offer.stripeProductId = product.id;
    offer.name = product.name;
    offer.documentsGranted = documentsGranted;
    offer.eligiblePlanType = eligiblePlanType;
    offer.amount = price.unit_amount;
    offer.currency = price.currency;
    // Un paquete cuyo producto está archivado no es vendible aunque su precio siga activo.
    offer.active = price.active && product.active;

    await this.documentPackOfferRepository.save(offer);
  }

  /** Cuántos documentos concede el paquete: del precio si lo declara, si no del producto. */
  private resolveDocumentsGranted(
    price: Stripe.Price,
    product: Stripe.Product,
  ): number {
    const raw =
      price.metadata?.documentsGranted?.trim() ||
      product.metadata?.documentsGranted?.trim();

    const documentsGranted = Number(raw);
    if (!raw || !Number.isInteger(documentsGranted) || documentsGranted <= 0) {
      throw new MissingDocumentPackMetadataException(
        price.id,
        'documentsGranted',
      );
    }

    return documentsGranted;
  }

  /**
   * Resuelve a qué plan se le ofrece este paquete. Ausente significa "a cualquiera", que es una
   * oferta válida y por eso no falla; lo que sí falla es nombrar un plan que no existe localmente.
   */
  private async resolveEligiblePlanType(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<string | null> {
    const planType =
      price.metadata?.eligiblePlanType?.trim() ||
      product.metadata?.eligiblePlanType?.trim();

    if (!planType) {
      return null;
    }

    const plan = await this.planRepository.findOne({
      where: { planType },
    });
    if (!plan) {
      throw new UnknownEligiblePlanMetadataException(price.id, planType);
    }

    return plan.planType;
  }

  private resolveInterval(price: Stripe.Price): BILLING_INTERVAL_ENUM | null {
    const interval = price.recurring?.interval;

    if (!interval) {
      // Un pago único sobre un producto marcado como plan: `plan_prices` sólo guarda precios
      // recurrentes (`interval` es NOT NULL), así que no hay dónde ponerlo.
      this.logger.warn(
        `El precio ${price.id} del plan no es recurrente; plan_prices sólo admite suscripciones.`,
      );
      return null;
    }

    const supported = SUPPORTED_INTERVALS[interval];
    if (!supported) {
      this.logger.warn(
        `El precio ${price.id} se factura cada '${interval}', periodicidad que el catálogo local no maneja; se ignora.`,
      );
      return null;
    }

    return supported;
  }

  private async deactivateByStripeProductId(
    repository: Repository<PlanEntity> | Repository<DocumentPackOfferEntity>,
    stripeProductId: string,
    label: string,
  ): Promise<void> {
    const result = await repository.update(
      { stripeProductId },
      { active: false },
    );

    if (!result.affected) {
      this.logger.warn(
        `product.deleted para ${stripeProductId} sin ningún ${label} local vinculado; nada que desactivar.`,
      );
    }
  }
}
