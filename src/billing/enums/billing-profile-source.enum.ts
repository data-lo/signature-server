/**
 * Por dónde se le factura HOY al propietario de un perfil.
 *
 * Es lo que distingue a un perfil que mantiene Stripe de uno que administración lleva a mano y de
 * uno que no paga nada. Sin ella, un perfil facturado por transferencia queda `ACTIVE`
 * conservando sus `stripe_*` viejos, y cualquier flujo que mire esos ids —cancelar, renovar— le
 * pediría a Stripe que actualice una suscripción que allá no existe.
 *
 * **Es un enum propio y NO el `BILLING_SOURCE_ENUM` de `subscription_billing_history`**, aunque
 * compartan dos de sus tres valores. Son preguntas distintas:
 *
 * ```
 * subscription_billing_history.source  quién cobró ESE periodo   (un hecho pasado)
 * billing_profiles.billing_source      quién factura AHORA        (el estado vigente)
 * ```
 *
 * Y sobre todo: aquélla no admite `FREE` y no puede admitirlo — su
 * `CHK_subscription_billing_history_origin_evidence` le exige a cada origen una evidencia de
 * cobro (la factura de Stripe, el folio del movimiento manual), y un plan gratuito no tiene
 * ninguna porque no hubo dinero. Agregar `FREE` al tipo compartido obligaría a relajar esa
 * restricción para todos los renglones del historial, que es exactamente lo que impide que
 * entren cobros a medias.
 *
 * Separarlos cuesta un tipo más en la base y ahorra el acoplamiento: el día que el historial
 * gane un origen nuevo, el perfil no se entera, y al revés.
 */
export enum BILLING_PROFILE_SOURCE_ENUM {
  /** La suscripción la cobra y la renueva Stripe. */
  STRIPE = 'STRIPE',
  /** Se factura fuera del proveedor (transferencia, efectivo) y se registra a mano. */
  MANUAL = 'MANUAL',
  /** No se le cobra: el plan gratuito. Es el valor con el que nace todo perfil. */
  FREE = 'FREE',
}
