/**
 * Estado comercial del propietario facturable.
 *
 * `FREE` no es "todavía nada": es el plan gratuito, que se administra ENTERAMENTE en esta base
 * de datos y no tiene producto, precio, cliente ni suscripción en Stripe. Toda cuenta nace así.
 *
 * La distinción con los otros tres estados es la que sostiene el módulo:
 *
 * ```
 * FREE       plan gratuito local, sin suscripción vigente en Stripe
 * INCOMPLETE abrió un checkout que todavía no se confirmó
 * ACTIVE     suscripción de pago vigente (aunque tenga la baja programada)
 * PAST_DUE   suscripción de pago con un cobro fallido
 * CANCELED   sincronizado desde un estado terminal de Stripe que no llegó a finalizarse
 * ```
 *
 * **`FREE` cubre dos historias distintas: quien nunca contrató y quien contrató y se fue.** No
 * siempre fue así. Antes el término definitivo dejaba el perfil en `CANCELED` justamente para no
 * perder esa diferencia, porque el perfil era el único sitio donde constaba. Desde que
 * `subscription_billing_history` guarda cada periodo con su plan, su cierre y su motivo, esa
 * información ya no depende del estado: distinguir a los dos públicos es una consulta al
 * historial, y el perfil puede decir lo único que le toca decir —qué tiene el cliente HOY—, que
 * es el plan gratuito en ambos casos.
 *
 * `CANCELED` sobrevive para el estado que Stripe informa por `customer.subscription.updated`
 * antes (o en lugar) de la baja definitiva. Cuando llega `customer.subscription.deleted`, el
 * perfil pasa a `FREE`.
 */
export enum BILLING_PROFILE_STATUS_ENUM {
  FREE = 'FREE',
  INCOMPLETE = 'INCOMPLETE',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  CANCELED = 'CANCELED',
}
