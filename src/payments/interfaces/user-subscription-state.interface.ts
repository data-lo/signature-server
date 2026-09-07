import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';

/**
 * Estado de la suscripción de la cuenta activa, leído de `billing_profiles`.
 *
 * Ya no describe una fila de `account_subscriptions`: aquel modelo lo sigue manteniendo el
 * webhook por compatibilidad, pero no es donde se activa el pago. Por eso los campos cambiaron
 * de nombre además de origen — `planId`, que era un enum cerrado de la tabla vieja, pasa a
 * `planType`, la llave abierta del catálogo con la que trabaja el módulo de facturación.
 */
export interface UserSubscriptionState {
  /** `true` sólo con `status = ACTIVE`; ningún otro estado habilita lo que se paga. */
  hasActiveSubscription: boolean;
  /** Plan vigente del catálogo (`basic`, `plus`, `premium`, ...). */
  planType: string | null;
  status: BILLING_PROFILE_STATUS_ENUM | null;
  /**
   * La baja está programada para el final del periodo vigente.
   *
   * Convive con `hasActiveSubscription: true` a propósito: el servicio sigue habilitado hasta
   * `currentPeriodEnd` y sólo entonces deja de renovarse. Es lo que la pantalla necesita para
   * decidir entre ofrecer "Cancelar suscripción" y anunciar la fecha de término, sin volver a
   * deducirlo de nada.
   */
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}
