import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanPriceEntity } from './plan-price.entity';
import { SubscriptionPriceNotAvailableException } from '../exceptions/billing.exceptions';

/**
 * Consulta el catálogo comercial LOCAL (`plan_prices` + `plans`).
 *
 * Es el reemplazo, para el flujo de suscripción, de preguntarle el catálogo a Stripe en cada
 * compra (lo que sigue haciendo `GetPaymentServicesUseCase` para pintar las tarjetas). La razón
 * no es el ahorro de una llamada: es que el importe y los límites que se cobran tienen que salir
 * de una fila nuestra, versionada y auditable, y no de lo que el proveedor conteste en ese
 * instante. `plans.monthly_document_limit` —cuántos documentos concede el plan— no existe en
 * Stripe en absoluto, así que sin el catálogo local no habría de dónde sacarlo al facturar.
 */
@Injectable()
export class BillingCatalogService {
  private readonly logger = new Logger(BillingCatalogService.name);

  constructor(
    @InjectRepository(PlanPriceEntity)
    private readonly planPriceRepository: Repository<PlanPriceEntity>,
  ) {}

  /**
   * Busca un precio recurrente vendible por su `stripe_price_id`.
   *
   * **Por qué no hay una comprobación explícita de "es recurrente":** la recurrencia es
   * estructural, no un campo que validar. `plan_prices` sólo contiene precios de suscripción —
   * `interval` e `interval_count` son NOT NULL en esa tabla— mientras que los pagos únicos viven
   * en `document_pack_offers`. Que el `price_...` aparezca aquí ES la comprobación; un precio de
   * paquete no se encuentra y cae por el mismo camino que uno inexistente.
   *
   * @throws {SubscriptionPriceNotAvailableException} Si no existe, o si el precio o su plan
   *   están dados de baja, o si está fuera de su ventana de vigencia.
   */
  async findSellableRecurringPrice(
    stripePriceId: string,
  ): Promise<PlanPriceEntity> {
    const price = await this.planPriceRepository.findOne({
      where: { stripePriceId, isActive: true },
      relations: { plan: true },
      order: { effectiveFrom: 'DESC' },
    });

    if (!price) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId}, que no está en plan_prices ` +
          '(no existe, o es un precio de pago único que no corresponde a una suscripción).',
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    if (!price.isActive) {
      this.logger.warn(
        `Se pidió suscribir al precio ${stripePriceId}, archivado en el catálogo local.`,
      );
      throw new SubscriptionPriceNotAvailableException();
    }

    if (!price.plan?.isActive) {
      this.logger.warn(
          `Se pidió suscribir al precio ${stripePriceId}, cuyo plan '${price.planType}' está dado de baja.`,
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
  ): Promise<PlanPriceEntity | null> {
    return this.planPriceRepository.findOne({
      where: { stripePriceId },
      relations: { plan: true },
      order: { effectiveFrom: 'DESC' },
    });
  }

  private isInEffectiveWindow(price: PlanPriceEntity): boolean {
    const now = Date.now();

    if (price.effectiveFrom && price.effectiveFrom.getTime() > now) {
      return false;
    }

    if (price.effectiveTo && price.effectiveTo.getTime() <= now) {
      return false;
    }

    return true;
  }
}
