/**
 * Ciclo de vida de una entrega de webhook.
 *
 * RECEIVED  → la entrega quedó registrada pero el caso de uso de dominio todavía no terminó.
 * PROCESSED → el dominio ejecutó sus reglas correctamente; una re-entrega del mismo evento
 *             se responde con éxito sin volver a ejecutar nada.
 * FAILED    → la firma no era válida, o el dominio lanzó un error. Un evento en FAILED sí
 *             se vuelve a intentar cuando el proveedor reenvía la entrega (ver
 *             `RegisterWebhookEventUseCase.register`).
 */
export enum WEBHOOK_PROCESSING_STATUS_ENUM {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}
