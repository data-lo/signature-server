/**
 * Respuesta que ven Didit y Stripe. Ambos proveedores sólo miran el código HTTP para decidir
 * si reintentan; el cuerpo es para nosotros al depurar entregas desde su panel.
 */
export interface WebhookReceptionResult {
  received: true;
  /** `true` cuando la entrega ya se había procesado y no se volvió a ejecutar el dominio. */
  duplicate: boolean;
}
