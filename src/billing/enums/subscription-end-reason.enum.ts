/**
 * Por qué terminó definitivamente una suscripción, según lo que informó Stripe.
 *
 * ```
 * CANCELED_AT_PERIOD_END  se pidió la baja y el periodo pagado llegó a su fin
 * PAYMENT_FAILURE         Stripe la dio de baja tras agotar los reintentos de cobro
 * STRIPE_TERMINATED       cualquier otro término confirmado por el proveedor
 * ```
 *
 * `STRIPE_TERMINATED` es el cajón de sastre deliberado: cubre la baja inmediata desde el
 * Dashboard, una disputa y cualquier motivo que Stripe añada en el futuro. Inventar un valor por
 * cada uno obligaría a desplegar cada vez que el proveedor amplíe su vocabulario, y lo que
 * necesita el negocio —distinguir "se fue" de "no pagó"— ya lo resuelven los dos primeros.
 */
export enum SUBSCRIPTION_END_REASON_ENUM {
  CANCELED_AT_PERIOD_END = 'CANCELED_AT_PERIOD_END',
  PAYMENT_FAILURE = 'PAYMENT_FAILURE',
  STRIPE_TERMINATED = 'STRIPE_TERMINATED',
}
