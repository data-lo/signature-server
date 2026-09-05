import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_ITEM_TYPE_ENUM } from '../enums/catalog-item-type.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import { CATALOG_SOURCE_ENUM } from '../enums/catalog-source.enum';
import { CATALOG_TYPE_ENUM } from '../enums/catalog-type.enum';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import {
  MissingDocumentPackMetadataException,
  MissingPlanTypeMetadataException,
  UnknownEligiblePlanMetadataException,
} from './exceptions/catalog-sync.exceptions';
import { CatalogItemEntity } from './catalog-item.entity';
import { CatalogPriceEntity } from './catalog-price.entity';
import { DocumentCreditPackEntity } from './document-credit-pack.entity';
import { PlanEntity } from './plan.entity';

const DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT = 1;

const SUPPORTED_INTERVALS: Record<string, BILLING_INTERVAL_ENUM> = {
  month: BILLING_INTERVAL_ENUM.MONTH,
  year: BILLING_INTERVAL_ENUM.YEAR,
};

/**
 * Mantiene el catálogo local a partir de los eventos de Stripe. El producto crea el ítem de
 * catálogo y su detalle (plan o paquete); el precio crea/versiona la oferta cobrable. Así el
 * modelo local también admite ítems MANUAL sin ids de Stripe.
 *
 * Vive separado de `StripeWebhookService`, que sólo enruta el evento ya autenticado, y de
 * `StripePaymentService`, que atiende el checkout: esto no es efecto de un pago sino mantenimiento
 * de catálogo, y un admin puede renombrar o desactivar un producto en el dashboard sin que nadie
 * compre nada.
 *
 * **Enruta por la metadata del PRODUCTO, no por nombre**: un producto de Stripe no dice si es plan o
 * paquete (ver `CATALOG_TYPE_ENUM`). Los eventos de precio se enrutan igual, y por eso
 * `syncPriceUpserted` recibe el producto ya resuelto: el payload de `price.*` sólo trae su id.
 *
 * **Nada se borra**: ni `product.deleted` ni un cambio de precio destruyen filas, se marcan
 * inactivas. `checkout_orders` apunta a `catalog_prices` con `ON DELETE RESTRICT`, así que el
 * importe cobrado tiene que seguir existiendo tal cual para las facturas y órdenes históricas.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(
    @InjectRepository(CatalogItemEntity)
    private readonly catalogItemRepository: Repository<CatalogItemEntity>,
    @InjectRepository(CatalogPriceEntity)
    private readonly catalogPriceRepository: Repository<CatalogPriceEntity>,
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
    @InjectRepository(DocumentCreditPackEntity)
    private readonly documentCreditPackRepository: Repository<DocumentCreditPackEntity>,
  ) {}

  /** `product.created` / `product.updated`: materializa el ítem y su detalle sin inventar dinero. */
  async syncProductUpserted(product: Stripe.Product): Promise<void> {
    switch (this.resolveCatalogType(product)) {
      case CATALOG_TYPE_ENUM.PLAN:
        await this.upsertPlan(product);
        return;
      case CATALOG_TYPE_ENUM.DOCUMENT_PACK: {
        const item = await this.upsertCatalogItem(
          product,
          CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
        );
        // Si documentsGranted sólo vive en Price, este detalle se terminará de crear en
        // price.created. El ítem sí queda registrado desde product.created.
        await this.upsertDocumentCreditPack(item, product, null);
        return;
      }
      default:
        return;
    }
  }

  async syncProductDeleted(product: Stripe.Product): Promise<void> {
    const itemType = this.toItemType(this.resolveCatalogType(product));
    if (!itemType) {
      return;
    }

    const item = await this.catalogItemRepository.findOne({
      where: { stripeProductId: product.id, itemType },
    });
    if (!item) {
      this.logger.warn(
        `product.deleted para ${product.id} sin un catalog_item local vinculado.`,
      );
      return;
    }

    if (item.source === CATALOG_SOURCE_ENUM.MANUAL) {
      this.logger.warn(
        `product.deleted para ${product.id} no desactiva el catalog_item MANUAL ${item.id}.`,
      );
      return;
    }

    item.isActive = false;
    await this.catalogItemRepository.save(item);
  }

  /** `price.created` / `price.updated`: asegura primero ítem + detalle y luego la oferta. */
  async syncPriceUpserted(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<void> {
    switch (this.resolveCatalogType(product)) {
      case CATALOG_TYPE_ENUM.PLAN: {
        const plan = await this.upsertPlan(product);
        if (!plan.catalogItemId) {
          throw new Error(
            `El plan ${plan.planType} no quedó vinculado a un catalog_item.`,
          );
        }
        await this.upsertPlanPrice(price, plan);
        return;
      }
      case CATALOG_TYPE_ENUM.DOCUMENT_PACK: {
        const item = await this.upsertCatalogItem(
          product,
          CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
        );
        await this.upsertDocumentPackPrice(price, product, item);
        return;
      }
      default:
        return;
    }
  }

  private resolveCatalogType(
    product: Stripe.Product,
  ): CATALOG_TYPE_ENUM | null {
    const raw = product.metadata?.catalogType?.trim().toLowerCase();
    if (!raw) {
      return null;
    }

    const type = Object.values(CATALOG_TYPE_ENUM).find(
      (value) => value === raw,
    );
    if (!type) {
      this.logger.warn(
        `Producto de Stripe ${product.id} con metadata.catalogType='${raw}' no reconocida; se ignora.`,
      );
      return null;
    }
    return type;
  }

  private toItemType(
    catalogType: CATALOG_TYPE_ENUM | null,
  ): CATALOG_ITEM_TYPE_ENUM | null {
    if (catalogType === CATALOG_TYPE_ENUM.PLAN) {
      return CATALOG_ITEM_TYPE_ENUM.PLAN;
    }
    if (catalogType === CATALOG_TYPE_ENUM.DOCUMENT_PACK) {
      return CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT;
    }
    return null;
  }

  private async upsertCatalogItem(
    product: Stripe.Product,
    itemType: CATALOG_ITEM_TYPE_ENUM,
  ): Promise<CatalogItemEntity> {
    const existing = await this.catalogItemRepository.findOne({
      where: { stripeProductId: product.id, itemType },
    });

    if (existing) {
      if (existing.source === CATALOG_SOURCE_ENUM.MANUAL) {
        this.logger.warn(
          `El catalog_item ${existing.id} está marcado MANUAL; el webhook no sobrescribe sus datos.`,
        );
        return existing;
      }
      existing.name = product.name;
      existing.isActive = product.active;
      return this.catalogItemRepository.save(existing);
    }

    const item = this.catalogItemRepository.create({
      itemType,
      source: CATALOG_SOURCE_ENUM.STRIPE,
      name: product.name,
      isActive: product.active,
      stripeProductId: product.id,
    });
    const created = await this.catalogItemRepository.save(item);
    this.logger.log(
      `catalog_item ${created.id} creado desde el producto de Stripe ${product.id}.`,
    );
    return created;
  }

  private resolvePlanType(product: Stripe.Product): string | null {
    return (
      product.metadata?.planType?.trim() ||
      product.metadata?.planCode?.trim() ||
      null
    );
  }

  private resolveDocumentsIncluded(product: Stripe.Product): number | null {
    return this.parsePositiveInteger(product.metadata?.documentsIncluded);
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
      plan = await this.planRepository.findOne({
        where: { planType },
      });
    }

    if (plan?.stripeProductId && plan.stripeProductId !== product.id) {
      throw new Error(
        `El plan ${plan.planType} ya está vinculado al producto ${plan.stripeProductId}; no puede reutilizarse para ${product.id}.`,
      );
    }

    const item = await this.resolvePlanCatalogItem(product, plan);
    const documentsIncluded = this.resolveDocumentsIncluded(product);
    if (plan) {
      // Un plan manual puede vincularse a Stripe para ser cobrado, pero sus beneficios no se
      // reescriben desde metadata. El ítem/price de Stripe siguen disponibles para checkout.
      plan.catalogItemId = item.id;
      plan.stripeProductId = product.id;
      if (plan.creationSource === PLAN_CREATION_SOURCE_ENUM.STRIPE) {
        plan.name = product.name;
        plan.isActive = product.active;
        if (documentsIncluded !== null) {
          plan.documentsIncluded = documentsIncluded;
        }
      }
      return this.planRepository.save(plan);
    }

    const created = this.planRepository.create({
      planType,
      catalogItemId: item.id,
      name: product.name,
      isActive: product.active,
      creationSource: PLAN_CREATION_SOURCE_ENUM.STRIPE,
      stripeProductId: product.id,
      documentsIncluded:
        documentsIncluded ?? DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT,
    });
    const saved = await this.planRepository.save(created);
    this.logger.warn(
      `Plan ${saved.planType} creado desde Stripe con ${saved.documentsIncluded} documentos incluidos.`,
    );
    return saved;
  }

  /**
   * Un plan creado manualmente ya tiene su propio catalog_item. Cuando se le publica un producto
   * de Stripe, se vincula ESE ítem en vez de crear otro y dejar el manual huérfano.
   */
  private async resolvePlanCatalogItem(
    product: Stripe.Product,
    plan: PlanEntity | null,
  ): Promise<CatalogItemEntity> {
    if (plan?.catalogItemId) {
      const existingItem = await this.catalogItemRepository.findOne({
        where: {
          id: plan.catalogItemId,
          itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
        },
      });

      if (existingItem) {
        if (
          existingItem.stripeProductId &&
          existingItem.stripeProductId !== product.id
        ) {
          throw new Error(
            `El catalog_item ${existingItem.id} ya está vinculado al producto ${existingItem.stripeProductId}.`,
          );
        }

        existingItem.stripeProductId = product.id;
        if (existingItem.source === CATALOG_SOURCE_ENUM.STRIPE) {
          existingItem.name = product.name;
          existingItem.isActive = product.active;
        }
        return this.catalogItemRepository.save(existingItem);
      }
    }

    return this.upsertCatalogItem(product, CATALOG_ITEM_TYPE_ENUM.PLAN);
  }

  private async upsertPlanPrice(
    price: Stripe.Price,
    plan: PlanEntity,
  ): Promise<void> {
    const interval = this.resolveRecurringInterval(price, 'plan');
    if (!interval || price.unit_amount == null || !plan.catalogItemId) {
      return;
    }

    await this.upsertCatalogPrice({
      price,
      catalogItemId: plan.catalogItemId,
      eligiblePlanType: null,
      billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
      interval,
      versionPreviousPrice: true,
    });
  }

  private async upsertDocumentPackPrice(
    price: Stripe.Price,
    product: Stripe.Product,
    item: CatalogItemEntity,
  ): Promise<void> {
    if (price.unit_amount == null) {
      this.logger.warn(
        `El precio ${price.id} del paquete ${product.id} no tiene unit_amount; no se sincroniza.`,
      );
      return;
    }
    if (price.recurring) {
      this.logger.warn(
        `El precio ${price.id} del paquete ${product.id} es recurrente; los créditos sólo admiten pago único.`,
      );
      return;
    }

    const pack = await this.upsertDocumentCreditPack(item, product, price);
    if (!pack) {
      throw new MissingDocumentPackMetadataException(
        price.id,
        'documentsGranted',
      );
    }
    const eligiblePlanType = await this.resolveEligiblePlanType(price, product);
    await this.upsertCatalogPrice({
      price,
      catalogItemId: item.id,
      eligiblePlanType,
      billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME,
      interval: null,
      // Dos precios de créditos activos pueden ser ofertas diferentes; no se relevan entre sí.
      versionPreviousPrice: false,
    });
  }

  private async upsertDocumentCreditPack(
    item: CatalogItemEntity,
    product: Stripe.Product,
    price: Stripe.Price | null,
  ): Promise<DocumentCreditPackEntity | null> {
    const documentsGranted = this.resolveDocumentsGranted(price, product);
    const existing = await this.documentCreditPackRepository.findOne({
      where: { catalogItemId: item.id },
    });

    if (documentsGranted === null) {
      if (!existing) {
        this.logger.warn(
          `catalog_item ${item.id} creado sin document_credit_pack: falta metadata.documentsGranted; se completará al recibir price.created.`,
        );
      }
      return existing;
    }

    if (existing) {
      if (item.source === CATALOG_SOURCE_ENUM.STRIPE) {
        existing.documentsGranted = documentsGranted;
        return this.documentCreditPackRepository.save(existing);
      }
      return existing;
    }

    const pack = this.documentCreditPackRepository.create({
      catalogItemId: item.id,
      documentsGranted,
    });
    const created = await this.documentCreditPackRepository.save(pack);
    this.logger.log(
      `document_credit_pack ${created.id} creado para catalog_item ${item.id}.`,
    );
    return created;
  }

  private resolveDocumentsGranted(
    price: Stripe.Price | null,
    product: Stripe.Product,
  ): number | null {
    const raw =
      price?.metadata?.documentsGranted ?? product.metadata?.documentsGranted;
    if (raw == null || !raw.trim()) {
      return null;
    }
    const value = this.parsePositiveInteger(raw);
    if (value === null) {
      throw new MissingDocumentPackMetadataException(
        price?.id ?? product.id,
        'documentsGranted',
      );
    }
    return value;
  }

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
    const plan = await this.planRepository.findOne({ where: { planType } });
    if (!plan) {
      throw new UnknownEligiblePlanMetadataException(price.id, planType);
    }
    return plan.planType;
  }

  private async upsertCatalogPrice(input: {
    price: Stripe.Price;
    catalogItemId: string;
    eligiblePlanType: string | null;
    billingMode: CATALOG_PRICE_BILLING_MODE_ENUM;
    interval: BILLING_INTERVAL_ENUM | null;
    versionPreviousPrice: boolean;
  }): Promise<void> {
    const {
      price,
      catalogItemId,
      eligiblePlanType,
      billingMode,
      interval,
      versionPreviousPrice,
    } = input;
    const intervalCount = interval
      ? (price.recurring?.interval_count ?? 1)
      : null;
    const activeVersion = await this.catalogPriceRepository.findOne({
      where: { stripePriceId: price.id, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });

    if (!price.active) {
      if (activeVersion) {
        activeVersion.isActive = false;
        activeVersion.effectiveTo = activeVersion.effectiveTo ?? new Date();
        await this.catalogPriceRepository.save(activeVersion);
      }
      return;
    }

    if (
      activeVersion &&
      this.hasSamePrice(
        activeVersion,
        catalogItemId,
        eligiblePlanType,
        price,
        billingMode,
        interval,
        intervalCount,
      )
    ) {
      return;
    }

    const now = new Date();
    if (activeVersion) {
      activeVersion.isActive = false;
      activeVersion.effectiveTo = activeVersion.effectiveTo ?? now;
      await this.catalogPriceRepository.save(activeVersion);
    }

    if (versionPreviousPrice) {
      await this.catalogPriceRepository.update(
        {
          catalogItemId,
          currency: price.currency,
          billingMode,
          interval,
          intervalCount,
          isActive: true,
        },
        { isActive: false, effectiveTo: now },
      );
    }

    const created = this.catalogPriceRepository.create({
      catalogItemId,
      eligiblePlanType,
      source: CATALOG_SOURCE_ENUM.STRIPE,
      stripePriceId: price.id,
      amount: price.unit_amount as number,
      currency: price.currency,
      billingMode,
      interval,
      intervalCount,
      isActive: true,
      effectiveFrom: now,
      effectiveTo: null,
    });
    await this.catalogPriceRepository.save(created);
    this.logger.log(
      `catalog_price creado para Stripe ${price.id} e item ${catalogItemId}.`,
    );
  }

  private hasSamePrice(
    version: CatalogPriceEntity,
    catalogItemId: string,
    eligiblePlanType: string | null,
    price: Stripe.Price,
    billingMode: CATALOG_PRICE_BILLING_MODE_ENUM,
    interval: BILLING_INTERVAL_ENUM | null,
    intervalCount: number | null,
  ): boolean {
    return (
      version.catalogItemId === catalogItemId &&
      version.eligiblePlanType === eligiblePlanType &&
      version.amount === price.unit_amount &&
      version.currency === price.currency &&
      version.billingMode === billingMode &&
      version.interval === interval &&
      version.intervalCount === intervalCount
    );
  }

  private resolveRecurringInterval(
    price: Stripe.Price,
    label: string,
  ): BILLING_INTERVAL_ENUM | null {
    if (price.unit_amount == null) {
      this.logger.warn(
        `El precio ${price.id} del ${label} no tiene unit_amount; no se sincroniza.`,
      );
      return null;
    }
    const raw = price.recurring?.interval;
    if (!raw) {
      this.logger.warn(
        `El precio ${price.id} del ${label} no es recurrente; se ignora.`,
      );
      return null;
    }
    const interval = SUPPORTED_INTERVALS[raw];
    if (!interval) {
      this.logger.warn(
        `El precio ${price.id} usa la periodicidad no soportada '${raw}'; se ignora.`,
      );
      return null;
    }
    return interval;
  }

  private parsePositiveInteger(raw: string | undefined): number | null {
    const value = Number(raw?.trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }
}
