/**
 * Respuesta de `POST /api/v1/payments/checkout-sessions`.
 *
 * Sólo la URL: el `session_id` no le sirve de nada al navegador —quien reconcilia el pago es el
 * webhook firmado— y exponerlo sólo daría material a quien quisiera manipular el retorno.
 *
 * La URL es **temporal**: Stripe la caduca, así que no se cachea ni se guarda en el cliente.
 */
export interface CheckoutSessionResponse {
  checkoutUrl: string;
}
