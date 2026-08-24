/**
 * Un servicio comprable, ya normalizado desde el catálogo del proveedor.
 *
 * Es la forma interna del dominio: la produce el gateway a partir de un producto y su precio,
 * y la consumen los casos de uso. No es lo que ve el frontend — para eso está
 * `PaymentServiceResponse`, que se queda con el subconjunto que necesitan las tarjetas.
 */
export interface PaymentService {
  /** `price_...`: identifica QUÉ se cobra y a qué importe. Es la llave del checkout. */
  priceId: string;
  /** `prod_...`: el producto al que pertenece el precio. */
  productId: string;
  name: string;
  description: string | null;
  /** Importe en la unidad mínima de la moneda (centavos), tal como lo maneja Stripe. */
  unitAmount: number | null;
  currency: string;
  /**
   * Periodicidad del cobro: `month`, `year`, etc. `null` en un pago único, que es justamente
   * lo que distingue una suscripción de una compra suelta.
   */
  interval: string | null;
  /** Cada cuántos `interval` se cobra (`interval: 'month'` + `intervalCount: 3` = trimestral). */
  intervalCount: number | null;
  imageUrl: string | null;
}
