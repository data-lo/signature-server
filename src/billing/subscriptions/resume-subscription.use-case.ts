import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  NoActiveSubscriptionToCancelException,
  NoScheduledCancellationToResumeException,
} from '../exceptions/billing.exceptions';
import type { SubscriptionScheduleResponse } from './subscription-schedule.interface';

/**
 * Deshace una baja programada: la suscripción vuelve a renovarse.
 *
 * **Es el camino de vuelta que le faltaba al flujo de cancelación.** Sin él, quien se daba de
 * baja por error quedaba encerrado: el botón de cancelar desaparece (ya está programada), el de
 * contratar tampoco puede aparecer —el perfil sigue `ACTIVE` y `CreateSubscriptionCheckoutUseCase`
 * rechaza con 409 cualquier checkout sobre uno activo— y la única salida era pedirle a alguien
 * que lo revirtiera desde el Dashboard de Stripe.
 *
 * **Sólo funciona mientras el periodo siga vigente.** Una vez que Stripe da de baja la
 * suscripción no se puede revivir: el perfil pasa a `CANCELED` por el webhook y desde ahí el
 * camino es contratar de nuevo, que sí está disponible porque el perfil ya no está activo. La
 * comprobación de `status = ACTIVE` es la que separa los dos mundos.
 *
 * Simétrico en todo con `CancelSubscriptionUseCase`: mismas validaciones, mismo orden —Stripe
 * primero, base después— y la misma respuesta. La única diferencia es el sentido de la bandera.
 */
@Injectable()
export class ResumeSubscriptionUseCase {
  private readonly logger = new Logger(ResumeSubscriptionUseCase.name);

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
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    this.assertResumable(profile, input.accountId);

    const subscription = await this.paymentGateway.resumeSubscription(
      profile.stripeSubscriptionId as string,
    );

    /**
     * Se mira el valor y no sólo la ausencia de excepción, igual que al cancelar: escribir
     * `false` local sobre una suscripción que Stripe sigue teniendo marcada para no renovar
     * dejaría al usuario creyendo que su plan continúa, y enterándose el día que se corte.
     */
    if (subscription.cancel_at_period_end) {
      this.logger.error(
        `Stripe mantuvo cancel_at_period_end en la suscripción ${profile.stripeSubscriptionId}; ` +
          'no se reanuda en el perfil.',
      );

      throw new NoScheduledCancellationToResumeException();
    }

    await this.billingProfileRepository.update(profile.id, {
      cancelAtPeriodEnd: false,
    });

    this.logger.log(
      `Suscripción reanudada para el perfil ${profile.id}: volverá a renovarse el ` +
        `${profile.currentPeriodEnd?.toISOString() ?? '(sin fecha registrada)'}.`,
    );

    return {
      status: profile.status,
      planType: profile.currentPlanType,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: profile.currentPeriodEnd,
    };
  }

  /**
   * Las mismas tres condiciones que para cancelar, más la inversa de la cuarta: tiene que HABER
   * una baja programada que deshacer.
   *
   * Se reutiliza `NoActiveSubscriptionToCancelException` para los tres primeros casos aunque el
   * verbo de su nombre sea el contrario: describe la situación —"no hay suscripción activa"— y no
   * la operación, y responde exactamente lo mismo (409 con el motivo en el log). Inventar una
   * excepción gemela sólo para cambiarle el nombre duplicaría el mensaje que ve el usuario.
   */
  private assertResumable(
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
        `El perfil ${profile.id} está en ${profile.status}, no ACTIVE: una suscripción ya ` +
          'terminada no se reanuda, se vuelve a contratar.',
      );
    }

    if (!profile.stripeSubscriptionId) {
      throw new NoActiveSubscriptionToCancelException(
        `El perfil ${profile.id} está ACTIVE pero no tiene stripe_subscription_id.`,
      );
    }

    if (!profile.cancelAtPeriodEnd) {
      throw new NoScheduledCancellationToResumeException();
    }
  }
}
