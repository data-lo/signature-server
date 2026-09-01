import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { PlanEntity } from './plan.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { CATALOG_TYPE_ENUM } from '../enums/catalog-type.enum';
import { MissingPlanCodeMetadataException } from './exceptions/catalog-sync.exceptions';

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
 * Sincroniza el catálogo comercial local (`plans`, `document_pack_offers`) con los productos de
 * Stripe. Vive separado de `StripeWebhookService` (que sólo enruta el evento ya autenticado) y de
 * `StripePaymentGatewayService` (que atiende el checkout): esto no es un efecto de un pago, es
 * mantenimiento de catálogo — un admin puede crear/renombrar/desactivar un producto en el
 * dashboard de Stripe sin que nadie compre nada, y aun así el catálogo local se tiene que enterar.
 *
 * **Enrutamiento por metadata, no por nombre.** Un producto de Stripe no dice si es un plan de
 * suscripción o un paquete de documentos — ver `CATALOG_TYPE_ENUM`.
 *
 * **Qué NO se toca nunca desde acá:** `monthlyDocumentLimit`, `allowSimpleSignature` y
 * `allowAdvancedSignature` de `PlanEntity`. Son configuración comercial interna (qué puede hacer
 * quien compró el plan), no algo que Stripe conozca — su Producto sólo tiene nombre, estado y
 * metadata. Sincronizarlos sobrescribiría, con nada, la configuración real cada vez que alguien
 * sólo quisiera renombrar el plan en el dashboard.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
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
        await this.upsertDocumentPackOffer(product);
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
   * cualquier borrado de este proyecto (ver `SkipJwtAuth`/soft-delete en otros módulos): el
   * catálogo puede referenciarse desde suscripciones u órdenes históricas, y un borrado físico
   * dejaría esas referencias colgando.
   */
  async syncProductDeleted(product: Stripe.Product): Promise<void> {
    const catalogType = this.resolveCatalogType(product);

    switch (catalogType) {
      case CATALOG_TYPE_ENUM.PLAN:
        await this.deactivateByStripeProductId(this.planRepository, product.id, 'plan');
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

  private resolveCatalogType(product: Stripe.Product): CATALOG_TYPE_ENUM | null {
    const raw = product.metadata?.catalogType?.trim().toLowerCase();

    if (!raw) {
      // Caso común, no un problema: la mayoría de los productos de una cuenta de Stripe no son
      // necesariamente parte de este catálogo. Un log aquí sería puro ruido.
      return null;
    }

    const match = Object.values(CATALOG_TYPE_ENUM).find((value) => value === raw);
    if (!match) {
      this.logger.warn(
        `Producto de Stripe ${product.id} con metadata.catalogType='${raw}' no reconocida ` +
          `(se esperaba '${CATALOG_TYPE_ENUM.PLAN}' o '${CATALOG_TYPE_ENUM.DOCUMENT_PACK}'); se ignora.`,
      );
      return null;
    }

    return match;
  }

  private async upsertPlan(product: Stripe.Product): Promise<void> {
    const planCode = product.metadata?.planCode?.trim();
    if (!planCode) {
      throw new MissingPlanCodeMetadataException(product.id);
    }

    // Primero por `stripeProductId`: si ya se vinculó antes, es la llave estable. La caída a
    // `code` sólo aplica al enlazar por primera vez.
    let plan = await this.planRepository.findOne({
      where: { stripeProductId: product.id },
    });

    if (!plan) {
      plan = await this.planRepository.findOne({ where: { code: planCode } });
    }

    if (plan) {
      plan.name = product.name;
      plan.active = product.active;
      plan.stripeProductId = product.id;
      await this.planRepository.save(plan);
      return;
    }

    this.logger.warn(
      `Creando el plan '${planCode}' a partir del producto de Stripe ${product.id} SIN ` +
        'configuración comercial local previa. Quedó con límites conservadores por defecto ' +
        `(monthlyDocumentLimit=${DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT}, firma simple sí / ` +
        'avanzada no) — revísalos antes de que alguien lo compre.',
    );

    const created = this.planRepository.create({
      code: planCode,
      name: product.name,
      active: product.active,
      stripeProductId: product.id,
      monthlyDocumentLimit: DEFAULT_NEW_PLAN_MONTHLY_DOCUMENT_LIMIT,
      allowSimpleSignature: true,
      allowAdvancedSignature: false,
    });
    await this.planRepository.save(created);
  }

  /**
   * A diferencia de `upsertPlan`, esto NUNCA crea una fila nueva. `documentsGranted`,
   * `stripePriceId`, `amount` y `currency` son NOT NULL en `document_pack_offers` y son datos
   * del PRECIO, no del producto — un evento `product.*` no los trae y no hay ningún valor
   * conservador razonable para inventarle a un `stripePriceId` (a diferencia de un límite de
   * documentos, un identificador de precio falso podría chocar con uno real que Stripe asigne
   * después). Sólo se puede enlazar un paquete que ya exista, dado de alta con su precio real.
   */
  private async upsertDocumentPackOffer(product: Stripe.Product): Promise<void> {
    const offer = await this.documentPackOfferRepository.findOne({
      where: { stripeProductId: product.id },
    });

    if (!offer) {
      this.logger.warn(
        `Producto de Stripe ${product.id} (metadata.catalogType='document_pack') sin ningún ` +
          'document_pack_offer local vinculado. No se crea uno nuevo: faltan datos del precio ' +
          '(documentsGranted/amount/currency/stripePriceId) que este evento no trae. Da de alta ' +
          'el paquete localmente con su precio real y vuelve a disparar el evento (o espera al ' +
          'próximo product.updated) para que quede enlazado.',
      );
      return;
    }

    offer.name = product.name;
    offer.active = product.active;
    await this.documentPackOfferRepository.save(offer);
  }

  private async deactivateByStripeProductId(
    repository: Repository<PlanEntity> | Repository<DocumentPackOfferEntity>,
    stripeProductId: string,
    label: string,
  ): Promise<void> {
    const result = await repository.update({ stripeProductId }, { active: false });

    if (!result.affected) {
      this.logger.warn(
        `product.deleted para ${stripeProductId} sin ningún ${label} local vinculado; nada que desactivar.`,
      );
    }
  }
}
