import { Injectable } from '@nestjs/common';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BillingOwnerService } from './billing-owner.service';

/**
 * Lo que la aplicación necesita saber de la facturación de una cuenta para dibujarse: si puede
 * usar lo que se paga, y bajo qué plan.
 *
 * Se queda deliberadamente en tres campos. `status` crudo y `current_period_end` existen en la
 * tabla, pero exponerlos obligaría a cada pantalla a reimplementar la regla de qué estados
 * habilitan el servicio — que es justamente lo que `hasActiveSubscription` resuelve de una vez
 * y en un solo sitio.
 */
export interface BillingStateResponse {
  billingProfileId: string | null;
  hasActiveSubscription: boolean;
  currentPlanType: string | null;
}

/** Cuenta sin perfil todavía: nunca intentó pagar. No es un error, es un estado legítimo. */
const SIN_PERFIL: BillingStateResponse = {
  billingProfileId: null,
  hasActiveSubscription: false,
  currentPlanType: null,
};

/**
 * Estado de facturación del propietario de la cuenta activa.
 *
 * Sustituye a `GetSubscriptionStateUseCase` como fuente de verdad del frontend, y la diferencia
 * no es de forma sino de a quién describe. Aquél lee `account_subscriptions` a partir de la
 * PRIMERA membresía activa del usuario (`findOne` por `userId`, sin `accountId`), así que un
 * usuario con cuenta personal y organización recibía siempre el estado de una de las dos —la que
 * la base devolviera primero— sin importar en cuál estuviera trabajando. Acá el propietario sale
 * del `X-Account-Id` que el usuario tiene seleccionado, y de `billing_profiles`, que es la tabla
 * que el webhook mantiene al día.
 *
 * **No crea el perfil.** Es una consulta de lectura que se dispara al entrar y al cambiar de
 * cuenta; dar de alta una fila por cada cuenta que alguien sólo miró ensuciaría la tabla y haría
 * que el caso "sin perfil" no volviera a darse nunca. El perfil se crea cuando se contrata
 * (ver `CreateSubscriptionCheckoutUseCase`), que es cuando de verdad hace falta.
 */
@Injectable()
export class GetBillingStateUseCase {
  constructor(private readonly billingOwnerService: BillingOwnerService) {}

  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<BillingStateResponse> {
    /**
     * `resolveOwner` hace dos cosas imprescindibles acá: comprueba que el usuario pertenezca de
     * verdad a la cuenta del header —sin eso, cambiar un valor en la petición dejaría leer el
     * plan de una organización ajena— y traduce la membresía al propietario, que es lo que
     * decide si se consulta por `personal_account_id` o por `organization_id`.
     */
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    if (!profile) {
      return SIN_PERFIL;
    }

    return {
      billingProfileId: profile.id,
      hasActiveSubscription:
        profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      /**
       * `INCOMPLETE`, `PAST_DUE` y `CANCELED` conservan su `current_plan_type`: el plan sigue
       * siendo el último contratado y la pantalla lo necesita para decir de cuál se trata. Lo
       * que no se puede es usarlo — eso lo dice `hasActiveSubscription`, y sólo eso.
       */
      currentPlanType: profile.currentPlanType,
    };
  }
}
