import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';

/**
 * Cómo queda la renovación de una suscripción después de programar su baja o de reanudarla.
 *
 * **La comparten los dos endpoints a propósito.** Cancelar y reanudar son la misma bandera en dos
 * sentidos, y el frontend los consume con el mismo código: si cada uno respondiera su propia
 * forma, bastaría con que uno añadiera un campo para que la tarjeta dibujara distinto según por
 * cuál de los dos hubiera pasado el usuario.
 *
 * Trae el estado ya actualizado para que la pantalla pueda redibujarse sin esperar a la consulta
 * nueva, aunque igualmente se invalide: describe el instante de la operación, y la fuente de
 * verdad sigue siendo el backend.
 */
export interface SubscriptionScheduleResponse {
  status: BILLING_PROFILE_STATUS_ENUM;
  planType: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Fin del periodo ya pagado. Con `cancelAtPeriodEnd: true` es la fecha efectiva de término;
   * con `false`, la fecha en que se cobrará la próxima renovación.
   */
  currentPeriodEnd: Date | null;
}
