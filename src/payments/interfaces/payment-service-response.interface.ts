/**
 * Lo que el frontend recibe para pintar cada tarjeta del catálogo.
 *
 * Se separa de `PaymentService` a propósito: el precio formateado y la periodicidad legible se
 * calculan una sola vez en el servidor, y así no viaja nada del proveedor que la pantalla no
 * necesite.
 *
 * Nótese lo que NO está: ni el `productId`, ni las llaves de Stripe, ni una URL de pago. La
 * sesión de Checkout es temporal y se crea al pulsar "Comprar", no al listar el catálogo.
 */
export interface PaymentServiceResponse {
  /** `price_...`: es lo que el frontend devuelve al pedir la sesión de Checkout. */
  priceId: string;
  /**
   * Plan del catálogo al que corresponde la tarjeta (`premium`, `plus`, ...), para poder
   * compararla con `currentPlanType` de `/payments/billing-state` y marcar cuál es el plan
   * vigente de la cuenta. `null` cuando el producto no declara la metadata.
   *
   * Es lo ÚNICO interno que se deja salir, y a propósito: sin esta llave el frontend tendría que
   * adivinar el plan por el nombre del producto, que ventas puede renombrar en cualquier momento
   * sin que nadie lo note hasta que el badge aparezca en la tarjeta equivocada.
   */
  planType: string | null;
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
