/**
 * Quién gobierna el ciclo de vida de la suscripción: quién decide cuándo empieza, cuándo se
 * renueva y cuándo termina.
 *
 * **No es lo mismo que `plan_type`, y confundirlos es el error que este enum viene a impedir.**
 * `plan_type` (`free`, `basic`, `plus`, …) dice QUÉ beneficios tiene el perfil; `billing_source`
 * dice QUIÉN los administra. Un perfil `plus` puede estar controlado por Stripe o haberse
 * facturado a mano fuera de la plataforma, y los dos casos requieren tratos opuestos: al primero
 * lo mueven los webhooks del proveedor, al segundo nadie — por eso hace falta un cron que lo
 * venza (`ExpireManualSubscriptionsJob`). Sin esta columna, distinguirlos obligaría a adivinar
 * por la presencia de `stripe_subscription_id`, que un perfil migrado de manual a Stripe (o al
 * revés) conserva por motivos históricos.
 *
 * ```
 * STRIPE  el proveedor manda: los webhooks activan, renuevan y cancelan. El cron NUNCA lo toca.
 * MANUAL  facturado fuera de la plataforma; el cron lo devuelve a Free cuando su periodo acaba.
 * FREE    plan gratuito; no hay periodo que vencer ni proveedor que consultar.
 * ```
 *
 * En `subscription_billing_history.source` sólo se escriben `STRIPE` y `MANUAL` —lo garantiza
 * `CHK_subscription_billing_history_source`—: el historial registra periodos FACTURADOS, y el
 * plan gratuito no factura nada. Que un perfil vuelva a `FREE` no reescribe su historial; los
 * periodos que sí se cobraron conservan para siempre el origen con el que se cobraron.
 */
export enum BILLING_SOURCE_ENUM {
  STRIPE = 'STRIPE',
  MANUAL = 'MANUAL',
  FREE = 'FREE',
}
