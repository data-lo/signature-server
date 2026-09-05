import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { InvalidBillingRegistrationException } from '../exceptions/billing.exceptions';
import {
  RegisterSubscriptionBillingUseCase,
  type RegisterSubscriptionBillingResult,
} from './register-subscription-billing.use-case';

export interface RegisterManualSubscriptionBillingInput {
  billingProfileId: string;
  planType: string;
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  documentsGranted?: number | null;
  /** Cuándo se cobró de verdad. Por omisión, ahora: la captura es el mismo día del ingreso. */
  paidAt?: Date | null;
  externalReference?: string | null;
  createdByUserId?: string | null;
  notes?: string | null;
}

/**
 * Registra un periodo cobrado FUERA de la plataforma: una transferencia, un depósito, una
 * factura emitida por administración.
 *
 * **No habla con Stripe, y eso es el requisito, no un detalle.** No crea sesión, ni cliente, ni
 * suscripción, ni factura, ni pago en el proveedor: el dinero ya entró por otra vía y darlo de
 * alta allá crearía un cobro fantasma que después alguien tendría que conciliar. La única huella
 * del cobro es la que se escribe aquí, y por eso la referencia externa importa tanto.
 *
 * **Casi todo lo hace `RegisterSubscriptionBillingUseCase`**, que es el punto en el que un cobro
 * manual y uno de Stripe se vuelven indistinguibles: los mismos créditos, el mismo historial, el
 * mismo perfil actualizado. Lo propio de este caso de uso es lo que aquél no puede saber — que el
 * origen es MANUAL, que la fecha de pago por omisión es ahora, y que quien dice haberlo
 * registrado tiene que existir.
 *
 * El perfil pasa a `billing_source = MANUAL`, que es lo que lo pone bajo el cuidado de
 * `ExpireManualSubscriptionsJob`: nadie va a avisar de que este periodo terminó, así que el cron
 * lo devolverá a Free cuando llegue `period_end` si no se registra otro antes.
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

  async execute(
    input: RegisterManualSubscriptionBillingInput,
  ): Promise<RegisterSubscriptionBillingResult> {
    await this.assertAuthorExists(input.createdByUserId);

    const result = await this.registerSubscriptionBilling.execute({
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
      /**
       * Explícitos en `null`, no omitidos: son la afirmación de que este camino no toca el
       * proveedor. Un cobro manual no tiene factura, cliente, suscripción ni intento de pago en
       * Stripe, y heredar los del perfil haría que el historial atribuyera a Stripe un ingreso
       * que Stripe nunca vio.
       */
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeInvoiceId: null,
      stripePaymentIntentId: null,
    });

    if (result.alreadyRegistered) {
      this.logger.warn(
        `La referencia ${input.externalReference} ya estaba registrada en el perfil ` +
          `${input.billingProfileId} (periodo ${result.history.id}); no se acredita dos veces.`,
      );
    }

    return result;
  }

  /**
   * Comprueba que el usuario que firma el registro exista y siga activo.
   *
   * Se hace ANTES de abrir la transacción y no se deja a la clave foránea: `created_by_user_id`
   * apunta a `users`, así que un id inventado reventaría a mitad del alta con una violación de
   * constraint —un error de Postgres en el log, sin decir cuál de los campos venía mal—. Y la FK
   * no comprueba lo que de verdad importa acá: que la cuenta siga vigente. Un cobro manual es la
   * única vía por la que se concede un plan sin dinero verificable por un tercero, así que su
   * autor es la mitad de la evidencia.
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
