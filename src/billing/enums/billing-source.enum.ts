/**
 * Quién cobró un periodo del historial de facturación.
 *
 * Hoy sólo se escribe `STRIPE`: es el único origen que produce periodos facturados en este
 * flujo. `MANUAL` existe porque la columna tiene que poder distinguirlos —un cobro registrado
 * fuera de la plataforma no tiene factura ni suscripción en el proveedor, y confundirlo con uno
 * de Stripe haría que la conciliación contra el proveedor reclamara un ingreso que allá no
 * existe—, no como un hueco a rellenar más adelante.
 */
export enum BILLING_SOURCE_ENUM {
  STRIPE = 'STRIPE',
  MANUAL = 'MANUAL',
}
