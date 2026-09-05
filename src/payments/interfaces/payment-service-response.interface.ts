/**
 * Lo que el frontend recibe para pintar cada tarjeta del catálogo.
 *
 * Se separa de `PaymentService` a propósito: el precio formateado y la periodicidad legible se
 * calculan una sola vez en el servidor, y así no viaja nada del proveedor que la pantalla no
 * necesite.
 *
 * No lleva `productId`, ni llaves de Stripe, ni una URL de pago: la sesión de Checkout es temporal y
 * se crea al pulsar "Comprar", no al listar el catálogo.
 */
export interface PaymentServiceResponse {
  /** `price_...`: es lo que el frontend devuelve al pedir la sesión de Checkout. */
  priceId: string;
  name: string;
  description: string | null;
  /** Importe en la unidad mínima de la moneda (centavos). */
  unitAmount: number | null;
  /** Código ISO en minúsculas, como lo devuelve Stripe (`mxn`, `usd`). */
  currency: string;
  /** `month` | `year` | ... ; `null` cuando es un pago único. */
  interval: string | null;
  intervalCount: number | null;
  imageUrl: string | null;
}
