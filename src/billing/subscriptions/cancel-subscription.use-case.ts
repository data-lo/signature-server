import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import type { SubscriptionScheduleResponse } from './subscription-schedule.interface';
import {
  NoActiveSubscriptionToCancelException,
  SubscriptionCancellationAlreadyScheduledException,
} from '../exceptions/billing.exceptions';

/**
 * Programa la baja de la suscripción de la cuenta activa para el final del periodo ya pagado.
 *
 * **No cancela nada ahora.** Le pide a Stripe que no emita la próxima factura y deja el perfil
 * tal cual: sigue `ACTIVE`, con su plan, su periodo, su suscripción y todos sus créditos. El
 * cliente pagó un mes y se lo queda entero. Lo único que cambia es `cancel_at_period_end`, que no
 * es un estado sino una intención: cuando llegue la fecha, Stripe dará de baja la suscripción y
 * su `customer.subscription.deleted` será el que mueva el perfil a `CANCELED`.
 *
 * **El orden importa: Stripe primero, base después.** Escribir localmente antes de que el
 * proveedor confirme dejaría a un usuario viendo "no se renovará" mientras la suscripción sigue
 * programada para cobrarse — y el siguiente cargo llegaría sin aviso. Al revés no hay daño
 * simétrico: si Stripe confirma y nuestro `UPDATE` falla, el perfil queda momentáneamente
 * desincronizado y el `customer.subscription.updated` que Stripe manda a continuación lo corrige
 * solo. Por eso el riesgo se pone del lado que el webhook sabe reparar.
 *
 * **La escritura local no es opcional aunque el webhook vaya a llegar.** Se hace inmediatamente
 * para que la interfaz no dependa de la latencia de la entrega: sin ella, el usuario cancelaría y
 * seguiría viendo el botón de cancelar durante los segundos que tarde el webhook, con toda la
 * pinta de que su clic no hizo nada.
 */
@Injectable()
export class CancelSubscriptionUseCase {
  private readonly logger = new Logger(CancelSubscriptionUseCase.name);

  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    private readonly billingOwnerService: BillingOwnerService,
    private readonly paymentGateway: StripePaymentService,
  ) {}

  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<SubscriptionScheduleResponse> {
    /**
     * `resolveOwner` hace dos cosas imprescindibles: comprueba que el usuario pertenezca de
     * verdad a la cuenta del header —sin eso, cambiar un valor en la petición dejaría cancelar
     * la suscripción de una organización ajena— y traduce la membresía al propietario, que es lo
     * que decide si se cancela lo de la persona o lo de la organización entera.
     */
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    this.assertCancelable(profile, input.accountId);

    /**
     * El adaptador devuelve la suscripción tal como quedó allá. Se comprueba el valor y no sólo
     * la ausencia de excepción: un 200 confirma que la petición se procesó, no necesariamente que
     * la baja quedara programada, y escribir `true` local sobre una suscripción que sigue
     * renovándose es justo el desajuste que este flujo no puede permitirse.
     */
    const subscription =
      await this.paymentGateway.scheduleSubscriptionCancellation(
        profile.stripeSubscriptionId as string,
      );

    if (!subscription.cancel_at_period_end) {
      this.logger.error(
        `Stripe respondió sin cancel_at_period_end para la suscripción ${profile.stripeSubscriptionId}; ` +
          'no se marca la baja en el perfil.',
      );

      throw new NoActiveSubscriptionToCancelException(
        `Stripe no programó la baja de ${profile.stripeSubscriptionId}.`,
      );
    }

    /**
     * **Sólo esta columna.** `status`, `current_plan_type`, el periodo y el
     * `stripe_subscription_id` se quedan donde están, y los `credit_lots` ni se miran: el cliente
     * conserva íntegro lo que compró hasta que el periodo termine de verdad.
     */
    await this.billingProfileRepository.update(profile.id, {
      cancelAtPeriodEnd: true,
    });

    this.logger.log(
      `Baja programada para el perfil ${profile.id} al terminar el periodo ` +
        `(${profile.currentPeriodEnd?.toISOString() ?? 'sin fecha registrada'}).`,
    );

    return {
      status: profile.status,
      planType: profile.currentPlanType,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: profile.currentPeriodEnd,
    };
  }

  /**
   * Las cuatro condiciones de la historia, comprobadas ANTES de tocar la red.
   *
   * Ninguna es redundante con Stripe: el proveedor rechazaría una suscripción inexistente, pero
   * con un error suyo que el usuario leería como una avería nuestra, y aceptaría sin rechistar
   * una segunda cancelación de algo ya cancelado —dejando al frontend sin forma de distinguir
   * "acabo de cancelar" de "ya estaba"—. Aquí cada caso tiene su 409 y su motivo.
   */
  private assertCancelable(
    profile: BillingProfileEntity | null,
    accountId: string,
  ): asserts profile is BillingProfileEntity {
    if (!profile) {
      throw new NoActiveSubscriptionToCancelException(
        `La cuenta ${accountId} no tiene billing_profile.`,
      );
    }

    if (profile.status !== BILLING_PROFILE_STATUS_ENUM.ACTIVE) {
      throw new NoActiveSubscriptionToCancelException(
        `El perfil ${profile.id} está en ${profile.status}, no ACTIVE.`,
      );
    }

    if (!profile.stripeSubscriptionId) {
      throw new NoActiveSubscriptionToCancelException(
        `El perfil ${profile.id} está ACTIVE pero no tiene stripe_subscription_id.`,
      );
    }

    if (profile.cancelAtPeriodEnd) {
      throw new SubscriptionCancellationAlreadyScheduledException();
    }
  }
}
