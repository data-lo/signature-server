import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type Stripe from 'stripe';
import { CreditLotEntity } from './credit-lot.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

/**
 * Prioridad de gasto de un lote comprado suelto.
 *
 * **Cero, igual que el de bienvenida, y no un valor intermedio.** El orden lo fija
 * `ConsumeDocumentCreditUseCase`: primero `priority` descendente —lo que pone por delante los
 * documentos del periodo facturado (100), que caducan al cerrarlo— y a igualdad de prioridad
 * manda la caducidad más próxima y después el lote más viejo. Con los add-on en cero, entre un
 * lote de bienvenida y uno comprado gana el más antiguo, que siempre es el de bienvenida: se
 * gasta primero lo regalado y sólo después lo pagado, que es el orden que le conviene al usuario.
 * Un valor intermedio invertiría eso y le quemaría los documentos comprados teniendo gratuitos
 * sin usar.
 */
const ADD_ON_LOT_PRIORITY = 0;

/**
 * Acredita los documentos de una compra suelta cuando Stripe confirma el pago.
 *
 * @remarks
 * Flujo:
 *
 * 1. Descarta lo que no le toca: sesiones que no son en modo `payment` o sin
 *    `metadata.billingProfileId`.
 * 2. Busca la orden `ADD_ON` de esa sesión, que es la fuente de qué se compró.
 * 3. Sale si la orden ya tiene lote, o si su paquete no declara cuántos documentos concede.
 * 4. En una transacción: emite el `credit_lot` con origen `ADD_ON`, cierra la orden como
 *    `COMPLETED` y la vincula al lote.
 *
 * Es la mitad de atrás de `CreateDocumentCreditCheckoutUseCase`. **No toca el plan ni el estado
 * del perfil**: comprar documentos no crea ni modifica una suscripción.
 *
 * Los documentos concedidos se leen de la orden y no de la metadata de la sesión: la orden se
 * registró antes de mandar al usuario a Stripe, con el `catalog_price` que se validó entonces.
 *
 * **La idempotencia es la razón de que el paso 4 sea una transacción y no tres escrituras.**
 * Stripe reentrega los webhooks, así que esto se ejecuta varias veces para el mismo pago con toda
 * normalidad, y se defiende en tres capas: la orden ya vinculada (paso 3), el lote ya emitido para
 * ese `payment_intent` (dentro de `issueLot`), y el índice único de
 * `credit_lots.stripe_payment_intent_id` como última red contra dos entregas simultáneas. Sin las
 * tres, una reentrega regalaría un segundo paquete por un solo cobro — y nadie lo notaría, porque
 * el usuario no se queja de que le sobren.
 */
@Injectable()
export class RegisterDocumentCreditPurchaseUseCase {
  private readonly logger = new Logger(
    RegisterDocumentCreditPurchaseUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly checkoutOrderService: CheckoutOrderService,
  ) {}

  /**
   * Ejecuta el caso de uso sobre un `checkout.session.completed` ya verificado.
   *
   * @remarks
   * Ignora en silencio lo que no le toca —sesiones de suscripción, o abiertas fuera de este
   * flujo— porque el mismo evento lo escuchan varios manejadores y cada uno atiende lo suyo. No
   * lanza: un webhook que falla se reintenta, y las situaciones irrecuperables (un paquete sin
   * cantidad declarada) se dejan en el log para resolverse a mano.
   *
   * @param session La sesión tal como la entrega Stripe.
   * @returns Nada: el efecto es la orden cerrada y el lote acreditado.
   */
  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (session.mode !== 'payment') {
      return;
    }

    const billingProfileId = session.metadata?.billingProfileId;
    if (!billingProfileId) {
      this.logger.debug(
        `checkout.session.completed en modo payment sin metadata.billingProfileId ` +
          `(sesión ${session.id}); no es una compra de documentos de este flujo.`,
      );
      return;
    }

    const order = await this.dataSource
      .getRepository(CheckoutOrderEntity)
      .findOne({
        where: {
          stripeCheckoutSessionId: session.id,
          kind: CHECKOUT_KIND_ENUM.ADD_ON,
        },
        relations: {
          catalogPrice: { catalogItem: { documentCreditPack: true } },
        },
      });

    if (!order) {
      this.logger.warn(
        `checkout.session.completed en modo payment para la sesión ${session.id} sin orden ` +
          'ADD_ON que cerrar (abierta fuera de este flujo, o de otro entorno).',
      );
      return;
    }

    // Primera capa de idempotencia, y la que corta la reentrega normal.
    if (order.creditSlotId) {
      this.logger.log(
        `La compra de la sesión ${session.id} ya había acreditado el lote ${order.creditSlotId}; ` +
          'no se emite otro.',
      );
      return;
    }

    const documentsGranted =
      order.catalogPrice?.catalogItem?.documentCreditPack?.documentsGranted;

    // No se elige un número por defecto: de menos estafa al que pagó, de más regala documentos.
    if (!documentsGranted) {
      this.logger.error(
        `La orden ${order.id} (sesión ${session.id}) no dice cuántos documentos concede su ` +
          'paquete; el pago quedó cobrado SIN acreditar. Revisar document_credit_packs del ítem ' +
          `${order.catalogPrice?.catalogItemId ?? 'desconocido'}.`,
      );
      return;
    }

    const stripePaymentIntentId = this.toId(session.payment_intent);

    await this.dataSource.transaction(async (manager) => {
      const creditLot = await this.issueLot(manager, {
        billingProfileId,
        documentsGranted,
        stripePaymentIntentId,
      });

      await this.checkoutOrderService.markCompleted(
        {
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeSubscriptionId: null,
        },
        manager,
      );

      await this.checkoutOrderService.linkCheckoutSessionToCreditSlot(
        {
          stripeCheckoutSessionId: session.id,
          creditSlotId: creditLot.id,
        },
        manager,
      );

      this.logger.log(
        `Compra de documentos confirmada: ${documentsGranted} documento(s) acreditados al perfil ` +
          `${billingProfileId} en el lote ${creditLot.id} (orden ${order.id}).`,
      );
    });
  }

  /**
   * Emite el lote de documentos comprados, o devuelve el que ya emitió este mismo pago.
   *
   * @remarks
   * `expiresAt`, `periodStart` y `periodEnd` quedan en `null`: lo comprado suelto no pertenece a
   * ningún periodo facturado y no caduca al cerrarlo. Atarlo al periodo vigente haría que un
   * paquete comprado el día 28 se evaporara dos días después.
   *
   * @param manager Transacción en curso; el lote, el cierre de la orden y el vínculo entre ambos
   *   quedan o no quedan los tres juntos.
   * @param input Perfil al que se acredita, documentos del paquete y el pago que lo originó.
   * @returns El lote emitido, o el que ya existía para ese `payment_intent`.
   */
  private async issueLot(
    manager: EntityManager,
    input: {
      billingProfileId: string;
      documentsGranted: number;
      stripePaymentIntentId: string | null;
    },
  ): Promise<CreditLotEntity> {
    const creditLotRepository = manager.getRepository(CreditLotEntity);

    // Cubre la entrega anterior que reventó justo entre emitir el lote y vincularlo a su orden.
    if (input.stripePaymentIntentId) {
      const existing = await creditLotRepository.findOne({
        where: { stripePaymentIntentId: input.stripePaymentIntentId },
      });

      if (existing) {
        this.logger.warn(
          `El pago ${input.stripePaymentIntentId} ya había emitido el lote ${existing.id} sin ` +
            'quedar vinculado a su orden; se reutiliza en vez de acreditar dos veces.',
        );
        return existing;
      }
    }

    return creditLotRepository.save(
      creditLotRepository.create({
        billingProfileId: input.billingProfileId,
        origin: CREDIT_LOT_ORIGIN_ENUM.ADD_ON,
        issued: input.documentsGranted,
        remaining: input.documentsGranted,
        priority: ADD_ON_LOT_PRIORITY,
        stripePaymentIntentId: input.stripePaymentIntentId,
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
        periodStart: null,
        periodEnd: null,
        expiresAt: null,
      }),
    );
  }

  /** Stripe entrega estos campos como id o como objeto expandido, según cómo se pidieran. */
  private toId(
    value: string | { id: string } | null | undefined,
  ): string | null {
    if (!value) {
      return null;
    }

    return typeof value === 'string' ? value : value.id;
  }
}
