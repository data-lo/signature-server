import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_PROFILE_SOURCE_ENUM } from '../enums/billing-profile-source.enum';
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
  /**
   * Define el origen del cobro: Stripe o manual.
   *
   * No es sólo una etiqueta del historial: decide con qué campo se comprueba la idempotencia
   * (`stripeInvoiceId` o `externalReference`), qué `billing_source` queda en el perfil, y si se
   * limpia `cancel_at_period_end`.
   */
  source: BILLING_SOURCE_ENUM;
  /** Plan concedido por este periodo; debe existir en `plans`. */
  planType: string;
  /** En la unidad mínima de la moneda (centavos), igual que Stripe y que `checkout_orders`. */
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** Cuándo entró el dinero. Se separa del periodo: un cobro puede capturarse con retraso. */
  paidAt: Date;
  /** Documentos a acreditar. Si se omite, los que declare el plan. */
  documentsGranted?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  /** Clave de idempotencia de un cobro de Stripe, y obligatoria en ese camino. */
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  /** Clave de idempotencia de un cobro manual: el folio del comprobante externo. */
  externalReference?: string | null;
  /** Quién capturó el cobro manual. Junto con el folio, es la evidencia que exige el CHECK. */
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
 * @remarks
 * Flujo:
 *
 * 1. Valida la coherencia de la entrada fuera de la transacción, porque no consulta nada.
 * 2. Abre transacción y bloquea el perfil (`pessimistic_write`); sin perfil no hay nada que
 *    facturar.
 * 3. Comprueba la idempotencia: por `stripe_invoice_id` si el cobro es de Stripe, por la
 *    referencia externa si es manual. Si ya estaba registrado, no escribe nada.
 * 4. Resuelve el plan del catálogo.
 * 5. Emite el `credit_lot` del periodo, arrastrando antes como `ROLLOVER` el saldo sin gastar.
 * 6. Vincula la orden de Checkout que originó el alta con el lote recién emitido.
 * 7. Escribe el renglón de `subscription_billing_history`.
 * 8. Actualiza el perfil: plan, estado `ACTIVE`, periodo vigente y `billing_source`.
 *
 * **Es el único sitio donde una suscripción concede saldo**, y da igual quién haya cobrado. Un
 * `invoice.paid` de Stripe y una transferencia capturada a mano terminan los dos aquí con los
 * mismos efectos; lo único que cambia es de dónde salen los datos y qué rastro queda. Tenerlo
 * centralizado impide que los dos caminos se separen: con la emisión dentro del adaptador de
 * Stripe, un cobro manual habría necesitado su propia copia del arrastre, el historial y la
 * actualización del perfil.
 *
 * **Todo ocurre en UNA transacción, con el perfil bloqueado.** Lote, historial, vínculo con la
 * orden y perfil quedan los cuatro o no queda ninguno; a medias, el cliente vería documentos que
 * ningún periodo justifica, o un periodo cobrado sin saldo. El bloqueo serializa además los
 * cobros del mismo perfil, que es lo que hace fiable el paso 3: comprobarlo fuera dejaría una
 * ventana en la que dos entregas simultáneas de la misma factura pasarían las dos.
 *
 * Las dos claves de idempotencia tienen además su índice único en la base, como última red.
 */
@Injectable()
export class RegisterSubscriptionBillingUseCase {
  private readonly logger = new Logger(RegisterSubscriptionBillingUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly checkoutOrderService: CheckoutOrderService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Periodo cobrado, su origen, el plan concedido y la evidencia del cobro.
   * @returns El renglón del historial y si el periodo ya estaba registrado de antes.
   * @throws {InvalidBillingRegistrationException} Cuando el importe, la moneda, las fechas, los
   *   documentos o la evidencia que exige el origen no son coherentes.
   * @throws {BillingProfileNotFoundForRegistrationException} Cuando el perfil no existe.
   * @throws {PlanNotFoundForRegistrationException} Cuando el plan no está en el catálogo.
   */
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

      // Antes del historial porque el id que devuelve es una de sus columnas.
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
   * Emite el lote del periodo, o reutiliza el que esa misma factura ya hubiera emitido.
   *
   * @remarks
   * La reutilización no es teórica: `credit_lots.stripe_invoice_id` viene de antes de que
   * existiera el historial, así que en una base que ya operaba pueden existir lotes de facturas
   * sin renglón. Una re-entrega encontraría el historial vacío, intentaría emitir otro lote y
   * chocaría contra el índice único, tumbando el webhook en bucle.
   *
   * El arrastre queda después de esa comprobación a propósito: sólo tiene sentido cuando de
   * verdad se emite saldo nuevo, y ejecutarlo al reutilizar reetiquetaría como `ROLLOVER` un lote
   * que sigue siendo el del periodo vigente.
   *
   * @param manager Transacción en curso.
   * @param input Periodo que se factura.
   * @param plan Plan resuelto, que aporta los documentos por periodo si no vienen en la entrada.
   * @returns El lote del periodo vigente.
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
   * Convierte en `ROLLOVER` el saldo vigente que quede sin gastar.
   *
   * @remarks
   * Sólo los lotes con `remaining > 0`: uno agotado no arrastra nada y reetiquetarlo ensuciaría
   * el historial de cómo se consumió cada periodo.
   *
   * @param manager Transacción en curso.
   * @param billingProfileId Perfil cuyo periodo anterior se arrastra.
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
   * Deja el perfil describiendo lo vigente.
   *
   * @remarks
   * Es la mitad del reparto con el historial: aquí vive el ESTADO ACTUAL —una fila, el plan y el
   * periodo de ahora—, allá el registro de cada periodo cobrado.
   *
   * Los ids de Stripe sólo se escriben si el cobro vino de Stripe, y nunca se borran: un cobro
   * manual no los aporta, y ponerlos a `null` tiraría el vínculo con cobros reales que todavía
   * hay que poder consultar.
   *
   * `cancel_at_period_end` se limpia sólo en el camino MANUAL: un periodo facturado a mano
   * sustituye cualquier intención previa de no renovar. En Stripe esa bandera la gobierna el
   * proveedor, y `invoice.paid` del periodo vigente llega DESPUÉS de programarse la cancelación
   * — limpiarla ahí revocaría en silencio una baja que el cliente sí pidió.
   *
   * `billing_source` se toma del origen del cobro y no de la presencia de los `stripe_*`: un
   * perfil que estuvo en Stripe y hoy se factura a mano conserva esos ids, y contaría como
   * STRIPE justo el caso que la columna existe para distinguir.
   *
   * @param manager Transacción en curso.
   * @param profile Perfil ya bloqueado.
   * @param input Periodo que se factura.
   * @param plan Plan que queda vigente.
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
      billingSource:
        input.source === BILLING_SOURCE_ENUM.STRIPE
          ? BILLING_PROFILE_SOURCE_ENUM.STRIPE
          : BILLING_PROFILE_SOURCE_ENUM.MANUAL,
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: input.periodEnd,
      ...(input.source === BILLING_SOURCE_ENUM.STRIPE
        ? {
            stripeCustomerId:
              input.stripeCustomerId ?? profile.stripeCustomerId,
            stripeSubscriptionId:
              input.stripeSubscriptionId ?? profile.stripeSubscriptionId,
          }
        : { cancelAtPeriodEnd: false }),
    });
  }

  /**
   * Busca el renglón que ya represente este cobro.
   *
   * @remarks
   * Un cobro manual sin folio no se puede desduplicar, y devuelve `null`. No es un descuido: sin
   * referencia externa no hay clave que distinga "el mismo cobro otra vez" de "un segundo cobro
   * idéntico" — dos meses seguidos del mismo plan por el mismo importe son legítimamente iguales.
   *
   * @param manager Transacción en curso, con el perfil ya bloqueado.
   * @param input Cobro que se intenta registrar.
   * @returns El periodo ya registrado, o `null` si es la primera vez.
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
   * @remarks
   * Todas estas reglas existen también en la base (`CHK_..._amount`, `CHK_..._period`,
   * `CHK_..._origin_evidence`), y no es duplicación ociosa: la base protege la integridad pase lo
   * que pase, y esto convierte el fallo en un 400 con el motivo concreto en vez de en una
   * violación de constraint a mitad de transacción.
   *
   * @param input Entrada a validar.
   * @throws {InvalidBillingRegistrationException} Con el motivo concreto del rechazo.
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
