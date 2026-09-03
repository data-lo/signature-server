import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { PlanEntity } from './plan.entity';
import { PlanPriceEntity } from './plan-price.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_TYPE_ENUM } from '../enums/catalog-type.enum';
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
 * productos y precios de Stripe. Vive separado de `StripeWebhookService` (que sólo enruta el
 * evento ya autenticado) y de `StripePaymentGatewayService` (que atiende el checkout): esto no es
 * un efecto de un pago, es mantenimiento de catálogo — un admin puede crear/renombrar/desactivar un
 * producto en el dashboard de Stripe sin que nadie compre nada, y aun así el catálogo local se
 * tiene que enterar.
 *
 * **Enrutamiento por metadata del PRODUCTO, no por nombre.** Un producto de Stripe no dice si es
 * un plan de suscripción o un paquete de documentos — ver `CATALOG_TYPE_ENUM`. Los eventos de
 * precio también se enrutan por la metadata de su producto: por eso `syncPriceUpserted` lo recibe
 * ya resuelto, porque el payload de `price.*` sólo trae su id.
 *
 * **Qué NO se toca nunca desde acá:** `monthlyDocumentLimit`, `allowSimpleSignature` y
 * `allowAdvancedSignature` de `PlanEntity`. Son configuración comercial interna (qué puede hacer
 * quien compró el plan), no algo que Stripe conozca — su Producto sólo tiene nombre, estado y
 * metadata. Sincronizarlos sobrescribiría, con nada, la configuración real cada vez que alguien
 * sólo quisiera renombrar el plan en el dashboard.
 *
 * **Nada se borra.** Ni `product.deleted` ni un cambio de precio destruyen filas: se marcan
 * inactivas. `checkout_orders` apunta a `plan_prices`/`document_pack_offers` con `ON DELETE
 * RESTRICT`, así que el importe que se cobró tiene que seguir existiendo tal cual para las
 * facturas y las órdenes históricas.
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
  ) {}

  /** `product.created` y `product.updated` comparten la misma lógica: upsert por `stripeProductId`. */
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
        // No es un `case` del switch a propósito: `resolveCatalogType` ya logueó lo que hacía
        // falta (o no logueó nada, si el producto simplemente no trae la metadata — el caso
        // común para cualquier otro producto de la cuenta de Stripe que no es de este catálogo).
        return;
    }
  }

  /**
   * `product.deleted` nunca borra la fila local — la marca inactiva. Es la misma regla que
   * cualquier borrado de este proyecto: el catálogo puede referenciarse desde suscripciones u
   * órdenes históricas, y un borrado físico dejaría esas referencias colgando.
   */
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

  /**
   * Qué plan local es este producto. `planType` es la llave que la metadata de Stripe usa hoy;
   * `planCode` se sigue aceptando porque es como se configuraron los productos antes de que esa
   * metadata se estandarizara, y un despliegue no puede exigir que alguien reedite el dashboard
   * antes de volver a arrancar.
   */
  private resolvePlanType(product: Stripe.Product): string | null {
    return (
      product.metadata?.planType?.trim() ||
      product.metadata?.planCode?.trim() ||
      null
    );
  }

  /** @returns La fila de `plans`, ya sincronizada: los precios la necesitan para su FK. */
  private async upsertPlan(product: Stripe.Product): Promise<PlanEntity> {
    const planType = this.resolvePlanType(product);
    if (!planType) {
      throw new MissingPlanTypeMetadataException(product.id);
    }

    // Primero por `stripeProductId`: si ya se vinculó antes, es la llave estable. La caída a
    // `code` sólo aplica al enlazar por primera vez.
    let plan = await this.planRepository.findOne({
      where: { stripeProductId: product.id },
    });

    if (!plan) {
      plan = await this.planRepository.findOne({ where: { code: planType } });
    }

    if (plan) {
      plan.name = product.name;
      plan.active = product.active;
      plan.stripeProductId = product.id;
      return this.planRepository.save(plan);
    }

    this.logger.warn(
      `Creando el plan '${planType}' a partir del producto de Stripe ${product.id} SIN ` +
        'configuración comercial local previa. Quedó con límites conservadores por defecto ' +
        `(monthlyDocumentLimit=${DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT}, firma simple sí / ` +
        'avanzada no) — revísalos antes de que alguien lo compre.',
    );

    const created = this.planRepository.create({
      code: planType,
      name: product.name,
      active: product.active,
      stripeProductId: product.id,
      monthlyDocumentLimit: DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT,
      allowSimpleSignature: true,
      allowAdvancedSignature: false,
    });
    return this.planRepository.save(created);
  }

  /**
   * De un producto de paquete sólo se sincroniza lo comercial: nombre y estado, sobre TODAS sus
   * ofertas. Un mismo producto puede tener varias filas —una por plan elegible y precio, ver
   * `upsertDocumentPackPrice`—, y el nombre del producto es el de todas ellas.
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
   * Precio de un plan: una fila de `plan_prices` por `stripe_price_id`.
   *
   * **Un importe distinto es un precio NUEVO, no una edición.** Stripe no deja cambiar el
   * `unit_amount` de un `price_...` existente: al cambiar el precio crea otro y emite
   * `price.created`. Por eso acá un id desconocido nunca actualiza una fila existente — inserta
   * una nueva y marca la anterior como inactiva, con su `effective_to` en el momento del relevo.
   * La fila vieja sobrevive intacta, con su `stripe_price_id` original, porque
   * `checkout_orders.plan_price_id` la referencia: sobrescribirla haría que una factura histórica
   * apuntara a un importe que nunca se cobró.
   *
   * Sobre un id ya conocido —el caso de `price.updated`— sólo se refleja el archivado o la
   * reactivación: es lo único que Stripe puede cambiar de un precio vivo.
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
      // Precios por tramos o con importe variable: `plan_prices.amount` es NOT NULL y no hay un
      // importe único que guardar. Se ignora en vez de guardar un 0 que se cobraría como gratis.
      this.logger.warn(
        `El precio ${price.id} del plan ${product.id} no tiene unit_amount (precio por tramos); no se sincroniza.`,
      );
      return;
    }

    const plan = await this.upsertPlan(product);

    const existing = await this.planPriceRepository.findOne({
      where: { stripePriceId: price.id },
    });

    if (existing) {
      existing.active = price.active;
      // Archivar cierra la vigencia; reactivar la reabre. El importe y el id no se tocan nunca.
      existing.effectiveTo = price.active
        ? null
        : (existing.effectiveTo ?? new Date());
      await this.planPriceRepository.save(existing);
      return;
    }

    const now = new Date();

    if (price.active) {
      await this.supersedePreviousPlanPrices(plan.code, price, interval, now);
    }

    const created = this.planPriceRepository.create({
      planCode: plan.code,
      stripePriceId: price.id,
      amount: price.unit_amount,
      currency: price.currency,
      interval,
      intervalCount: price.recurring?.interval_count ?? 1,
      active: price.active,
      effectiveFrom: now,
      effectiveTo: null,
    });
    await this.planPriceRepository.save(created);
  }

  /**
   * Cierra los precios vigentes a los que éste releva: mismo plan, misma moneda y misma
   * periodicidad. La comparación es tan estrecha a propósito — el precio mensual y el anual del
   * mismo plan conviven, igual que el mismo plan en dos monedas, y desactivar uno al publicar el
   * otro dejaría al plan sin una de sus dos formas de compra.
   */
  private async supersedePreviousPlanPrices(
    planCode: string,
    price: Stripe.Price,
    interval: BILLING_INTERVAL_ENUM,
    supersededAt: Date,
  ): Promise<void> {
    await this.planPriceRepository.update(
      {
        planCode,
        currency: price.currency,
        interval,
        intervalCount: price.recurring?.interval_count ?? 1,
        active: true,
      },
      { active: false, effectiveTo: supersededAt },
    );
  }

  /**
   * Precio de un paquete de documentos: una fila de `document_pack_offers` por `stripe_price_id`.
   *
   * La fila —y no el producto— es la unidad del catálogo de paquetes, porque el mismo paquete
   * puede venderse a distinto importe según el plan del comprador (`eligiblePlanType`) y en
   * distintos tamaños (`documentsGranted`). Todas esas filas comparten `stripe_product_id`.
   *
   * Por eso mismo un precio nuevo NO releva a los anteriores, al revés que en los planes: dos
   * precios activos del mismo producto suelen ser dos ofertas distintas y legítimas, no dos
   * versiones de la misma. Quien las da de baja es Stripe, archivándolas (`price.updated` con
   * `active: false`).
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
    const eligiblePlanCode = await this.resolveEligiblePlanCode(price, product);

    const existing = await this.documentPackOfferRepository.findOne({
      where: { stripePriceId: price.id },
    });

    const offer =
      existing ??
      this.documentPackOfferRepository.create({ stripePriceId: price.id });

    offer.stripeProductId = product.id;
    offer.name = product.name;
    offer.documentsGranted = documentsGranted;
    offer.eligiblePlanCode = eligiblePlanCode;
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
   * A qué plan se le ofrece este paquete. Ausente significa "a cualquiera", que es una oferta
   * válida y por eso no falla; lo que sí falla es nombrar un plan que no existe localmente.
   */
  private async resolveEligiblePlanCode(
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
      where: { code: planType },
    });
    if (!plan) {
      throw new UnknownEligiblePlanMetadataException(price.id, planType);
    }

    return plan.code;
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
