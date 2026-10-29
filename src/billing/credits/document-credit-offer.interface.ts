/**
 * Un paquete de documentos que la cuenta activa puede comprar, tal como lo pinta el frontend.
 *
 * **Todo sale del catálogo local** (`catalog_items` + `document_credit_packs` +
 * `catalog_prices`), nunca de Stripe en vivo ni de constantes en el código: el importe y los
 * documentos que se prometen tienen que salir de filas nuestras, versionadas y auditables, o no
 * hay forma de responder después por qué se le cobró eso a alguien.
 */
export interface DocumentCreditOfferResponse {
  /** Lo que el frontend devuelve para abrir el Checkout. Es el id LOCAL, no el de Stripe. */
  catalogPriceId: string;
  /** Nombre del ítem de catálogo ("Documento adicional"). */
  name: string;
  /** Documentos que acredita el paquete cuando el pago se confirma. */
  documentsGranted: number;
  /** Importe en la unidad mínima de la moneda (centavos), como en el resto del módulo. */
  amount: number;
  /** Código ISO en minúsculas: `mxn`, `usd`. */
  currency: string;
  /**
   * `price_...` del proveedor.
   *
   * Se expone porque la historia lo pide explícitamente, pero **el frontend no lo usa para
   * comprar**: el checkout se abre con `catalogPriceId` y es el backend quien resuelve el precio
   * de Stripe. Mandarlo desde el cliente permitiría cobrar un precio que no es el que se mostró.
   *
   * `null` en un precio administrado sólo en nuestra base que todavía no se publicó en Stripe;
   * esas ofertas no se pueden llevar a Checkout y por eso no se listan.
   */
  stripePriceId: string | null;
}
