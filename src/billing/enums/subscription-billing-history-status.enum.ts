/**
 * Si un periodo del historial es el vigente o ya se cerró.
 *
 * Sólo dos valores porque sólo hay dos preguntas que responder: cuál es el periodo que manda
 * ahora mismo (`ACTIVE`, del que hay como mucho uno por perfil — lo impone
 * `UQ_subscription_billing_history_active`) y cuáles quedaron atrás (`EXPIRED`). El MOTIVO por
 * el que un periodo se cerró no vive acá sino en `ended_reason`, que es lo que separa un periodo
 * que se agotó de uno que fue sustituido por una renovación.
 */
export enum SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
}
