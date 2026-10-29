/**
 * Una línea cobrada en una sesión de Checkout, reducida a lo que la reconciliación necesita.
 *
 * Existe para que `billing` no dependa de la forma de los objetos del SDK de Stripe: el webhook de
 * compra de documentos sólo necesita saber QUÉ precio se cobró, CUÁNTAS unidades y POR CUÁNTO.
 */
export interface CheckoutSessionLineItem {
  /** `price_...` cobrado; `null` si Stripe no lo reporta (una línea armada con `price_data`). */
  stripePriceId: string | null;
  /** Unidades realmente pagadas. `0` si Stripe no la reporta, para que nunca cuadre con una orden. */
  quantity: number;
  /** Importe de la línea antes de descuentos e impuestos, en la unidad mínima de la moneda. */
  amountSubtotal: number;
  /** Código ISO en minúsculas, como lo entrega Stripe. */
  currency: string;
}
