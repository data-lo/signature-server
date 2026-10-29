import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { InvalidBillingRegistrationException } from '../exceptions/billing.exceptions';
import {
  RegisterSubscriptionBillingUseCase,
  type RegisterSubscriptionBillingInput,
  type RegisterSubscriptionBillingResult,
} from './register-subscription-billing.use-case';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';

export interface RegisterManualSubscriptionBillingInput {
  billingProfileId: string;
  /** Plan concedido por este periodo; debe existir en `plans`. */
  planType: string;
  /** Importe cobrado, en la unidad mínima de la moneda. */
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** Documentos a acreditar. `null` deja que mande lo que el plan incluye por periodo. */
  documentsGranted?: number | null;
  /** Cuándo se cobró de verdad. Por omisión, ahora: la captura es el mismo día del ingreso. */
  paidAt?: Date | null;
  /**
   * Comprobante del cobro fuera de la plataforma (folio de transferencia, número de factura).
   *
   * Es la llave de idempotencia de este camino: un cobro manual no tiene factura de Stripe con la
   * que reconocerse, así que registrar dos veces la misma referencia no acredita dos veces.
   */
  externalReference?: string | null;
  /** Quién registra el cobro. Se comprueba que exista y siga activo: es la mitad de la evidencia. */
  createdByUserId?: string | null;
  notes?: string | null;
}

/**
 * Registra un periodo cobrado FUERA de la plataforma: una transferencia, un depósito, una factura
 * emitida por administración.
 *
 * @remarks
 * Flujo:
 *
 * 1. Comprueba que el usuario que firma el registro exista y siga activo.
 * 2. Delega en `RegisterSubscriptionBillingUseCase` con `source = MANUAL`, la fecha de pago por
 *    omisión y los identificadores de Stripe explícitamente en `null`.
 * 3. Avisa en el log si la referencia externa ya estaba registrada y no se acreditó nada.
 *
 * **No habla con Stripe, y eso es el requisito.** No crea sesión, cliente, suscripción, factura ni
 * pago en el proveedor: el dinero ya entró por otra vía y darlo de alta allá crearía un cobro
 * fantasma que alguien tendría que conciliar. La única huella del cobro es la que se escribe aquí,
 * y por eso la referencia externa importa tanto — es la idempotencia de este camino.
 *
 * **Casi todo lo hace `RegisterSubscriptionBillingUseCase`**, que es el punto en el que un cobro
 * manual y uno de Stripe se vuelven indistinguibles: los mismos créditos, el mismo historial, el
 * mismo perfil. Lo propio de aquí es lo que aquél no puede saber.
 *
 * El perfil pasa a `billing_source = MANUAL`, que lo pone bajo el cuidado de
 * `ExpireManualSubscriptionsJob`: nadie va a avisar de que este periodo terminó, así que el cron
 * lo devolverá a Free al llegar `period_end` si no se registra otro antes.
 */
@Injectable()
export class RegisterManualSubscriptionBillingUseCase {
  private readonly logger = new Logger(
    RegisterManualSubscriptionBillingUseCase.name,
  );

  constructor(
    private readonly registerSubscriptionBilling: RegisterSubscriptionBillingUseCase,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Periodo cobrado, plan concedido, importe y evidencia del cobro.
   * @returns El periodo registrado, con `alreadyRegistered` en `true` si la referencia externa ya
   *   se había capturado antes.
   * @throws {InvalidBillingRegistrationException} Cuando el usuario que registra el cobro no
   *   existe o está dado de baja, o cuando el periodo no es válido.
   * @throws {BillingProfileNotFoundForRegistrationException} Cuando el perfil no existe.
   * @throws {PlanNotFoundForRegistrationException} Cuando el plan no está en el catálogo.
   */
  async execute(
    input: RegisterManualSubscriptionBillingInput,
  ): Promise<RegisterSubscriptionBillingResult> {
    await this.assertAuthorExists(input.createdByUserId);

    const result = await this.registerSubscriptionBilling.execute(
      toSubscriptionBillingInput(input),
    );
    this.warnIfAlreadyRegistered(input, result);

    return result;
  }

  /**
   * Registra el periodo manual dentro de la transacción del llamador, con las mismas reglas que
   * `execute`.
   *
   * Para los flujos que crean el perfil y lo facturan en la misma operación (el aprovisionamiento
   * interno): si algo posterior falla, el periodo y sus créditos se revierten con lo demás.
   *
   * @param manager - Transacción en curso.
   * @param input - Periodo cobrado, plan concedido, importe y evidencia del cobro.
   * @returns El periodo registrado, con `alreadyRegistered` en `true` si la referencia externa ya
   *   estaba capturada en ese perfil.
   *
   * @throws {InvalidBillingRegistrationException} Cuando el autor no existe o el periodo no es
   *   válido.
   * @throws {BillingProfileNotFoundForRegistrationException} Cuando el perfil no existe.
   * @throws {PlanNotFoundForRegistrationException} Cuando el plan no está en el catálogo.
   *
   * @example
   * ```ts
   * const { history } = await registerManual.executeWithin(manager, {
   *   billingProfileId: profile.id, planType: 'enterprise', amount: 0, currency: 'mxn',
   *   periodStart, periodEnd, documentsGranted: 1600, externalReference: 'PROVISION-ACME-TEST-001',
   * });
   * ```
   */
  async executeWithin(
    manager: EntityManager,
    input: RegisterManualSubscriptionBillingInput,
  ): Promise<RegisterSubscriptionBillingResult> {
    await this.assertAuthorExists(input.createdByUserId);

    const result = await this.registerSubscriptionBilling.executeWithin(
      manager,
      toSubscriptionBillingInput(input),
    );
    this.warnIfAlreadyRegistered(input, result);

    return result;
  }

  /**
   * Busca un periodo manual por su referencia externa, en CUALQUIER perfil.
   *
   * La unicidad de la base (`UQ_subscription_billing_history_manual_reference`) es por perfil;
   * esto sirve a quien necesita que el folio sea único en toda la plataforma (el aprovisionamiento
   * interno, cuyo perfil siempre es nuevo y nunca chocaría contra ese índice).
   *
   * @param manager - Transacción en curso.
   * @param externalReference - Folio buscado.
   * @returns El periodo que ya usa ese folio, o `null`.
   *
   * @example
   * ```ts
   * const taken = await registerManual.findByExternalReference(manager, 'PROVISION-ACME-TEST-001');
   * ```
   */
  findByExternalReference(
    manager: EntityManager,
    externalReference: string,
  ): Promise<SubscriptionBillingHistoryEntity | null> {
    return manager.getRepository(SubscriptionBillingHistoryEntity).findOne({
      where: { source: BILLING_SOURCE_ENUM.MANUAL, externalReference },
    });
  }

  private warnIfAlreadyRegistered(
    input: RegisterManualSubscriptionBillingInput,
    result: RegisterSubscriptionBillingResult,
  ): void {
    if (result.alreadyRegistered) {
      this.logger.warn(
        `La referencia ${input.externalReference} ya estaba registrada en el perfil ` +
          `${input.billingProfileId} (periodo ${result.history.id}); no se acredita dos veces.`,
      );
    }
  }

  /**
   * Comprueba que el usuario que firma el registro exista y siga activo.
   *
   * @remarks
   * Se hace antes de abrir la transacción y no se deja a la clave foránea: un id inventado
   * reventaría a mitad del alta con una violación de constraint, sin decir qué campo venía mal. Y
   * la FK no comprueba lo que importa —que la cuenta siga vigente—. Un cobro manual es la única
   * vía por la que se concede un plan sin dinero verificable por un tercero, así que su autor es
   * la mitad de la evidencia.
   *
   * @param createdByUserId Autor declarado del registro; sin él no hay nada que comprobar.
   * @throws {InvalidBillingRegistrationException} Cuando el autor no existe o está dado de baja.
   */
  private async assertAuthorExists(
    createdByUserId: string | null | undefined,
  ): Promise<void> {
    if (!createdByUserId) {
      return;
    }

    const author = await this.userRepository.findOne({
      where: { id: createdByUserId, isActive: true, isDeleted: false },
    });

    if (!author) {
      throw new InvalidBillingRegistrationException(
        'el usuario que registra el cobro no existe o está dado de baja.',
      );
    }
  }
}

/**
 * Traduce un cobro manual a la entrada común de `RegisterSubscriptionBillingUseCase`: origen
 * `MANUAL`, fecha de pago por omisión y los identificadores de Stripe explícitamente en `null`.
 *
 * @param input - Cobro manual.
 * @returns La entrada del registro de periodos.
 *
 * @example
 * ```ts
 * toSubscriptionBillingInput({ billingProfileId: 'bp-1', planType: 'plus', amount: 0, currency: 'mxn', periodStart, periodEnd });
 * ```
 */
function toSubscriptionBillingInput(
  input: RegisterManualSubscriptionBillingInput,
): RegisterSubscriptionBillingInput {
  return {
    billingProfileId: input.billingProfileId,
    source: BILLING_SOURCE_ENUM.MANUAL,
    planType: input.planType,
    amount: input.amount,
    currency: input.currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    paidAt: input.paidAt ?? new Date(),
    documentsGranted: input.documentsGranted ?? null,
    externalReference: input.externalReference ?? null,
    createdByUserId: input.createdByUserId ?? null,
    notes: input.notes ?? null,
    // Explícitos en `null`: heredar los del perfil atribuiría a Stripe un ingreso que no vio.
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeInvoiceId: null,
    stripePaymentIntentId: null,
  };
}
