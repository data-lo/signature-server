import { Injectable } from '@nestjs/common';
import { BillingOwnerService } from 'src/billing/profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { UserSubscriptionState } from '../interfaces/user-subscription-state.interface';

/** Cuenta sin perfil: nunca intentó pagar. No es un error, es un estado legítimo. */
const SIN_SUSCRIPCION: UserSubscriptionState = {
  hasActiveSubscription: false,
  planType: null,
  status: null,
  cancelAtPeriodEnd: false,
  currentPeriodStart: null,
  currentPeriodEnd: null,
};

/**
 * Estado de la suscripción de la CUENTA ACTIVA, leído de `billing_profiles`.
 *
 * **El cambio de fondo es de dónde sale la verdad.** Antes se leía `account_subscriptions`, y de
 * ahí venía el síntoma que se reportó: quien acababa de pagar seguía viendo su suscripción
 * inactiva. No era un fallo de la pantalla, era que miraba la tabla que ya no manda — el cobro
 * lo confirma el webhook `invoice.paid` sobre `billing_profiles`, que es donde se pone
 * `status = ACTIVE` y se emiten los documentos del periodo, mientras `account_subscriptions`
 * sobrevive sólo por compatibilidad y no refleja esa activación.
 *
 * **El segundo cambio es a quién se describe.** La consulta anterior resolvía la cuenta con un
 * `findOne` por `userId` y sin `accountId`, así que a un usuario con cuenta personal y
 * organización le devolvía siempre el estado de una de las dos —la que la base sacara primero—
 * sin importar en cuál estuviera trabajando. Ahora el propietario sale del `X-Account-Id` que el
 * usuario tiene seleccionado, vía `resolveOwner`, que de paso comprueba que pertenezca de verdad
 * a esa cuenta: sin esa validación, cambiar un valor de la petición dejaría leer la suscripción
 * de una organización ajena.
 *
 * **No crea el perfil.** Es una consulta de lectura: preguntar "¿qué plan tengo?" no puede dar
 * de alta filas de facturación. El perfil se crea al contratar.
 */
@Injectable()
export class GetSubscriptionStateUseCase {
  constructor(private readonly billingOwnerService: BillingOwnerService) {}

  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<UserSubscriptionState> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    if (!profile) {
      return SIN_SUSCRIPCION;
    }

    return {
      /**
       * Sólo ACTIVE. Los demás estados conservan su `planType` —sigue siendo el plan del que se
       * habla— pero ninguno habilita lo que se paga: `INCOMPLETE` es un checkout sin cobrar,
       * `PAST_DUE` un cobro que falló y `CANCELED` una baja.
       */
      hasActiveSubscription:
        profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      planType: profile.currentPlanType,
      status: profile.status,
      /**
       * No se cruza con `hasActiveSubscription`: son dos preguntas distintas y la pantalla
       * necesita las dos por separado. Una suscripción con la baja programada está activa Y no se
       * renovará, y colapsarlas dejaría al usuario sin saber cuál de las dos cosas está viendo.
       */
      cancelAtPeriodEnd: profile.cancelAtPeriodEnd,
      currentPeriodStart: profile.currentPeriodStart,
      currentPeriodEnd: profile.currentPeriodEnd,
    };
  }
}
