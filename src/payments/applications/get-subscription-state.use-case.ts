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
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable desde el usuario y la cuenta activa, comprobando de paso
 *    la membresía: sin eso, cambiar un valor de la petición dejaría leer la suscripción de una
 *    organización ajena.
 * 2. Busca su `billing_profile`. Sin perfil responde el estado "nunca intentó pagar".
 * 3. Proyecta el perfil al contrato de la pantalla.
 *
 * La verdad sale de `billing_profiles` y no de `account_subscriptions`: el cobro lo confirma el
 * webhook `invoice.paid` sobre el perfil, y aquella tabla sobrevive sólo por compatibilidad sin
 * reflejar la activación — de ahí venía el síntoma de "pagué y sigo inactivo".
 *
 * **No crea el perfil**: preguntar qué plan se tiene no puede dar de alta filas de facturación.
 *
 * @deprecated Sustituido por `GetBillingAccessUseCase` (`GET /payments/billing-state`), que
 * responde esto y además el saldo, los beneficios y los límites en una sola consulta.
 */
@Injectable()
export class GetSubscriptionStateUseCase {
  constructor(private readonly billingOwnerService: BillingOwnerService) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Usuario autenticado y cuenta activa, que juntos deciden por qué propietario
   *   facturable se pregunta.
   * @returns El estado de la suscripción; el estado vacío si la cuenta no tiene perfil.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   */
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
      // Sólo ACTIVE habilita lo que se paga; los demás conservan el plan para nombrarlo.
      hasActiveSubscription:
        profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      planType: profile.currentPlanType,
      status: profile.status,
      // No se cruza con `hasActiveSubscription`: una baja programada sigue activa Y no se renueva.
      cancelAtPeriodEnd: profile.cancelAtPeriodEnd,
      currentPeriodStart: profile.currentPeriodStart,
      currentPeriodEnd: profile.currentPeriodEnd,
    };
  }
}
