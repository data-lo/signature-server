/**
 * Quién cobró un periodo de suscripción.
 *
 * `subscription_billing_history` guarda con esta columna el origen de cada periodo facturado, y
 * de ahí cuelga qué evidencia se le exige a la fila: un cobro de `STRIPE` trae el id de su
 * factura —que es además su clave de idempotencia, porque el proveedor reintenta las entregas—,
 * y uno `MANUAL` trae el folio del movimiento o, como mínimo, quién lo registró. Lo impone
 * `CHK_subscription_billing_history_origin_evidence`.
 *
 * **No sustituye a `plan_type` ni se deduce de él.** `plan_type` dice QUÉ se compró (`free`,
 * `basic`, `plus`); esto dice POR DÓNDE entró el dinero. El mismo plan se puede cobrar por
 * Checkout o por transferencia, y separarlos es lo que permite conciliar contra Stripe sin
 * arrastrar lo que Stripe nunca vio.
 *
 * Tampoco se deduce de la presencia de `stripe_subscription_id`: un perfil que en su día estuvo
 * en Stripe conserva sus ids como referencia histórica aunque hoy se le facture a mano.
 */
export enum BILLING_SOURCE_ENUM {
  STRIPE = 'STRIPE',
  MANUAL = 'MANUAL',
}
