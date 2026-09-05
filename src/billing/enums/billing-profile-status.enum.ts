/**
 * Estado comercial del propietario facturable.
 *
 * `FREE` no es "todavía nada": es el plan gratuito, que se administra ENTERAMENTE en esta base
 * de datos y no tiene producto, precio, cliente ni suscripción en Stripe. Toda cuenta nace así.
 *
 * La distinción con los otros tres estados es la que sostiene el módulo:
 *
 * ```
 * FREE       plan gratuito local, sin suscripción en Stripe   (nunca ha pagado)
 * INCOMPLETE abrió un checkout que todavía no se confirmó
 * ACTIVE     suscripción de pago vigente
 * PAST_DUE   suscripción de pago con un cobro fallido
 * CANCELED   tuvo una suscripción de pago y se dio de baja
 * ```
 *
 * `FREE` y `CANCELED` se parecen desde fuera —ninguno habilita lo que se paga— pero decirlo con
 * el mismo valor perdería el dato que separa a quien nunca contrató de quien contrató y se fue,
 * que es exactamente lo que hace falta para saber a quién ofrecerle un plan y a quién
 * recuperarlo.
 */
export enum BILLING_PROFILE_STATUS_ENUM {
  FREE = 'FREE',
  INCOMPLETE = 'INCOMPLETE',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  CANCELED = 'CANCELED',
}
