import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import {
  BillingProfileNotFoundForRegistrationException,
  InvalidBillingRegistrationException,
  PlanNotFoundForRegistrationException,
} from '../exceptions/billing.exceptions';

/**
 * Prioridad del lote del periodo vigente. Mayor que la de un lote de arrastre para que el consumo
 * gaste primero lo que caduca antes — el sobrante arrastrado ya sobrevivió a un periodo y no
 * tiene por qué competir con lo recién emitido.
 */
const CURRENT_PERIOD_LOT_PRIORITY = 100;

export interface RegisterSubscriptionBillingInput {
  billingProfileId: string;
  source: BILLING_SOURCE_ENUM;
  planType: string;
  /** En la unidad mínima de la moneda (centavos), igual que Stripe y que `checkout_orders`. */
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  /** Documentos a acreditar. Si se omite, los que declare el plan. */
  documentsGranted?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  externalReference?: string | null;
  createdByUserId?: string | null;
  notes?: string | null;
}

export interface RegisterSubscriptionBillingResult {
  history: SubscriptionBillingHistoryEntity;
  /** `true` si el periodo ya estaba registrado y esta llamada no escribió nada. */
  alreadyRegistered: boolean;
}

/**
 * Anota un periodo PAGADO: emite sus créditos, lo registra en el historial y deja el
 * `billing_profile` describiendo lo que está vigente ahora.
 *
 * **Es el único sitio donde una suscripción concede saldo**, y da igual quién haya cobrado. Un
 * `invoice.paid` de Stripe y una transferencia capturada a mano por administración terminan los
 * dos acá con los mismos efectos; lo único que cambia es de dónde salen los datos y qué rastro
 * queda (`stripe_invoice_id` en un caso, `external_reference` / `created_by_user_id` en el otro).
 * Tenerlo centralizado es lo que impide que los dos caminos se separen: cuando el saldo se
 * emitía dentro del adaptador de Stripe, cualquier cobro fuera de Stripe habría necesitado su
 * propia copia de la lógica de arrastre, historial y actualización del perfil — y bastaría con
 * que una de las dos copias cambiara para que un cliente manual dejara de recibir lo mismo que
 * uno de Stripe.
 *
 * **Todo ocurre en UNA transacción, con el perfil bloqueado.** El lote de créditos, el renglón
 * del historial, el vínculo con la orden de compra y la actualización del perfil quedan los
 * cuatro o no queda ninguno; a medias, el cliente vería documentos que ningún periodo justifica,
 * o un periodo cobrado sin saldo. El bloqueo pesimista serializa además los cobros del mismo
 * perfil, que es lo que hace fiable la comprobación de idempotencia: leerla fuera dejaría una
 * ventana en la que dos entregas simultáneas de la misma factura pasarían las dos.
 *
 * **La idempotencia se comprueba, no se asume.** Por `stripe_invoice_id` cuando el cobro viene de
 * Stripe —que reintenta las entregas durante días— y por la referencia manual cuando lo captura
 * una persona, que es igual de capaz de enviar el formulario dos veces. Ambas tienen además su
 * índice único en la base como última red.
 */
@Injectable()
export class RegisterSubscriptionBillingUseCase {
  private readonly logger = new Logger(RegisterSubscriptionBillingUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly checkoutOrderService: CheckoutOrderService,
  ) {}

  async execute(
    input: RegisterSubscriptionBillingInput,
  ): Promise<RegisterSubscriptionBillingResult> {
    this.assertInputIsCoherent(input);

    return this.dataSource.transaction(async (manager) => {
      const profile = await manager.findOne(BillingProfileEntity, {
        where: { id: input.billingProfileId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!profile) {
        throw new BillingProfileNotFoundForRegistrationException(
          input.billingProfileId,
        );
      }

      const already = await this.findAlreadyRegistered(manager, input);
      if (already) {
        this.logger.log(
          `El periodo ${already.id} ya registraba este cobro (${this.describeCobro(input)}); ` +
            'no se emiten créditos ni se toca el perfil.',
        );
        return { history: already, alreadyRegistered: true };
      }

      const plan = await manager.findOne(PlanEntity, {
        where: { planType: input.planType },
      });

      if (!plan) {
        throw new PlanNotFoundForRegistrationException(input.planType);
      }

      const lot = await this.issueCreditLot(manager, input, plan);

      /**
       * El vínculo con la compra se resuelve ANTES de escribir el historial porque el id que
       * devuelve es una de sus columnas. Devuelve `null` en una renovación o en un cobro manual:
       * en ninguno de los dos hubo una sesión de Checkout que apuntar.
       */
      const checkoutOrderId =
        await this.checkoutOrderService.linkCompletedSubscriptionToCreditSlot(
          {
            billingProfileId: profile.id,
            stripeSubscriptionId: input.stripeSubscriptionId ?? null,
            creditSlotId: lot.id,
          },
          manager,
        );

      const history = await this.openPeriod(manager, input, {
        billingProfileId: profile.id,
        planType: plan.planType,
        creditSlotId: lot.id,
        checkoutOrderId,
      });

      await this.updateProfile(manager, profile, input, plan);

      this.logger.log(
        `Perfil ${profile.id} facturado por ${input.source}: periodo ${history.id} del plan ` +
          `${plan.planType}, lote ${lot.id} y ${lot.issued} documento(s) acreditado(s).`,
      );

      return { history, alreadyRegistered: false };
    });
  }

  /**
   * Emite el lote del periodo, o REUTILIZA el que esa misma factura ya hubiera emitido.
   *
   * El caso de reutilización no es teórico: `credit_lots.stripe_invoice_id` viene de antes de que
   * existiera el historial, así que en una base que ya operaba pueden existir lotes de facturas
   * que nunca dejaron renglón. Una re-entrega de una de ellas encontraría el historial vacío,
   * intentaría emitir un lote nuevo y chocaría contra el índice único de esa columna, tumbando el
   * webhook en bucle. Reutilizando el lote, el cobro queda registrado sin duplicar ni un
   * documento.
   *
   * El arrastre del periodo anterior va DENTRO del `if` a propósito: sólo tiene sentido cuando de
   * verdad se emite saldo nuevo. Ejecutarlo al reutilizar reetiquetaría como ROLLOVER un lote que
   * sigue siendo el del periodo vigente.
   */
  private async issueCreditLot(
    manager: EntityManager,
    input: RegisterSubscriptionBillingInput,
    plan: PlanEntity,
  ): Promise<CreditLotEntity> {
    const creditLotRepository = manager.getRepository(CreditLotEntity);

    if (input.stripeInvoiceId) {
      const existing = await creditLotRepository.findOne({
        where: { stripeInvoiceId: input.stripeInvoiceId },
      });

      if (existing) {
        this.logger.warn(
          `La factura ${input.stripeInvoiceId} ya había emitido el lote ${existing.id} sin ` +
            'renglón de historial; se reutiliza en vez de acreditar dos veces.',
        );
        return existing;
      }
    }

    await this.rolloverPreviousPeriod(manager, input.billingProfileId);

    const issued = input.documentsGranted ?? plan.documentsIncluded;

    return creditLotRepository.save(
      creditLotRepository.create({
        billingProfileId: input.billingProfileId,
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
        issued,
        remaining: issued,
        priority: CURRENT_PERIOD_LOT_PRIORITY,
        stripeInvoiceId: input.stripeInvoiceId ?? null,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      }),
    );
  }

  /**
   * Convierte en ROLLOVER el saldo vigente que quede sin gastar.
   *
   * Sólo los lotes con `remaining > 0`: un lote agotado no arrastra nada y reetiquetarlo sólo
   * ensuciaría el historial de cómo se consumió cada periodo.
   */
  private async rolloverPreviousPeriod(
    manager: EntityManager,
    billingProfileId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(CreditLotEntity)
      .set({ origin: CREDIT_LOT_ORIGIN_ENUM.ROLLOVER })
      .where('billing_profile_id = :billingProfileId', { billingProfileId })
      .andWhere('origin = :origin', {
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
      })
      .andWhere('remaining > 0')
      .execute();

    if (result.affected) {
      this.logger.log(
        `${result.affected} lote(s) del periodo anterior pasaron a ROLLOVER en el perfil ${billingProfileId}.`,
      );
    }
  }

  private async openPeriod(
    manager: EntityManager,
    input: RegisterSubscriptionBillingInput,
    links: {
      billingProfileId: string;
      planType: string;
      creditSlotId: string;
      checkoutOrderId: string | null;
    },
  ): Promise<SubscriptionBillingHistoryEntity> {
    const historyRepository = manager.getRepository(
      SubscriptionBillingHistoryEntity,
    );

    return historyRepository.save(
      historyRepository.create({
        billingProfileId: links.billingProfileId,
        checkoutOrderId: links.checkoutOrderId,
        creditSlotId: links.creditSlotId,
        source: input.source,
        planType: links.planType,
        amount: input.amount,
        currency: input.currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        paidAt: input.paidAt,
        stripeCustomerId: input.stripeCustomerId ?? null,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        stripeInvoiceId: input.stripeInvoiceId ?? null,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        externalReference: input.externalReference ?? null,
        createdByUserId: input.createdByUserId ?? null,
        notes: input.notes ?? null,
      }),
    );
  }

  /**
   * Deja el perfil describiendo lo vigente. Es la mitad del reparto de trabajo con el historial:
   * aquí vive el ESTADO ACTUAL, allá el registro de cada periodo.
   *
   * **Los ids de Stripe sólo se escriben si el cobro vino de Stripe**, y nunca se borran: un
   * perfil que pasa a facturación manual conserva los suyos como referencia histórica, y ponerlos
   * a `null` desde acá tiraría el vínculo con cobros reales que aún hay que poder consultar.
   *
   * `cancel_at_period_end` se limpia sólo en el camino MANUAL. Un periodo manual nuevo sustituye
   * cualquier intención previa de no renovar; en el camino de Stripe esa bandera la gobierna el
   * proveedor a través de `customer.subscription.updated`, y pisarla desde un cobro podría
   * contradecir una baja que el cliente ya pidió.
   */
  /**
   * Deja el perfil describiendo lo vigente. Es la mitad del reparto de trabajo con el historial:
   * acá vive el ESTADO ACTUAL —una sola fila, siempre el plan y el periodo de ahora—, allá el
   * registro de cada periodo que se cobró.
   *
   * **Los ids de Stripe sólo se escriben si el cobro vino de Stripe**, y nunca se borran: un
   * cobro manual no los aporta, y ponerlos a `null` desde acá tiraría el vínculo con cobros
   * reales que todavía hay que poder consultar. Por eso el `spread` condicionado en vez de
   * asignarlos siempre.
   */
  private async updateProfile(
    manager: EntityManager,
    profile: BillingProfileEntity,
    input: RegisterSubscriptionBillingInput,
    plan: PlanEntity,
  ): Promise<void> {
    await manager.update(BillingProfileEntity, profile.id, {
      currentPlanType: plan.planType,
      status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: input.periodEnd,
      ...(input.source === BILLING_SOURCE_ENUM.STRIPE
        ? {
            stripeCustomerId:
              input.stripeCustomerId ?? profile.stripeCustomerId,
            stripeSubscriptionId:
              input.stripeSubscriptionId ?? profile.stripeSubscriptionId,
          }
        : {}),
    });
  }

  /**
   * Busca el renglón que ya represente este cobro.
   *
   * Se hace DENTRO de la transacción y DESPUÉS de bloquear el perfil: comprobarlo antes dejaría
   * una ventana en la que dos entregas simultáneas de la misma factura pasarían las dos.
   *
   * **Un cobro manual sin folio no se puede desduplicar** y aquí se devuelve `null`. No es un
   * descuido: sin referencia externa no hay ninguna clave que distinga "el mismo cobro otra vez"
   * de "un segundo cobro idéntico al primero" —dos meses seguidos del mismo plan por el mismo
   * importe son legítimamente iguales—. Por eso el endpoint manual pide folio siempre que exista
   * uno, y por eso el CHECK de la tabla exige al menos folio o autor.
   */
  private async findAlreadyRegistered(
    manager: EntityManager,
    input: RegisterSubscriptionBillingInput,
  ): Promise<SubscriptionBillingHistoryEntity | null> {
    const historyRepository = manager.getRepository(
      SubscriptionBillingHistoryEntity,
    );

    if (input.source === BILLING_SOURCE_ENUM.STRIPE) {
      return historyRepository.findOne({
        where: { stripeInvoiceId: input.stripeInvoiceId },
      });
    }

    if (!input.externalReference) {
      return null;
    }

    return historyRepository.findOne({
      where: {
        billingProfileId: input.billingProfileId,
        source: BILLING_SOURCE_ENUM.MANUAL,
        externalReference: input.externalReference,
      },
    });
  }

  /**
   * Valida lo que ningún constraint puede explicar bien después.
   *
   * Todas estas reglas existen también en la base (`CHK_..._amount`, `CHK_..._period`,
   * `CHK_..._origin_evidence`), y no es duplicación ociosa: la base protege la integridad pase lo
   * que pase, y esto convierte el fallo en un 400 con el motivo concreto en vez de en una
   * violación de constraint a mitad de transacción, que llega al log como un error de Postgres
   * sin decir qué campo venía mal. Corre FUERA de la transacción porque no consulta nada.
   */
  private assertInputIsCoherent(input: RegisterSubscriptionBillingInput): void {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new InvalidBillingRegistrationException(
        'el importe debe ser un entero de centavos mayor o igual que cero.',
      );
    }

    if (!input.currency || input.currency.length !== 3) {
      throw new InvalidBillingRegistrationException(
        'la moneda debe ser un código ISO de tres letras.',
      );
    }

    if (
      !(input.periodStart instanceof Date) ||
      !(input.periodEnd instanceof Date) ||
      !(input.paidAt instanceof Date)
    ) {
      throw new InvalidBillingRegistrationException(
        'el inicio, el fin y la fecha de pago del periodo son obligatorios.',
      );
    }

    if (input.periodStart.getTime() >= input.periodEnd.getTime()) {
      throw new InvalidBillingRegistrationException(
        'el periodo debe terminar después de empezar.',
      );
    }

    if (
      input.documentsGranted !== undefined &&
      input.documentsGranted !== null &&
      (!Number.isInteger(input.documentsGranted) || input.documentsGranted < 1)
    ) {
      throw new InvalidBillingRegistrationException(
        'los documentos a acreditar deben ser un entero mayor que cero.',
      );
    }

    if (input.source === BILLING_SOURCE_ENUM.STRIPE && !input.stripeInvoiceId) {
      throw new InvalidBillingRegistrationException(
        'un cobro de Stripe necesita su stripe_invoice_id, que es su clave de idempotencia.',
      );
    }

    if (
      input.source === BILLING_SOURCE_ENUM.MANUAL &&
      !input.externalReference &&
      !input.createdByUserId
    ) {
      throw new InvalidBillingRegistrationException(
        'un cobro manual necesita una referencia externa o el usuario que lo registra.',
      );
    }
  }

  private describeCobro(input: RegisterSubscriptionBillingInput): string {
    return input.source === BILLING_SOURCE_ENUM.STRIPE
      ? `factura ${input.stripeInvoiceId}`
      : `referencia ${input.externalReference}`;
  }
}
