/**
 * Estado de una entrega lógica (`webhook_deliveries.status`).
 *
 * ```text
 * PENDING ─► DELIVERING ─► DELIVERED
 *               │
 *               ├─► RETRY_SCHEDULED ─► DELIVERING …
 *               └─► FAILED ─(reintento manual)─► PENDING
 * PENDING | RETRY_SCHEDULED | FAILED ─► CANCELLED
 * ```
 */
export enum WEBHOOK_DELIVERY_STATUS_ENUM {
  /** Registrada; espera su primer intento en `next_attempt_at`. */
  PENDING = 'PENDING',
  /**
   * Un worker la reclamó y está enviando el POST hasta `lease_expires_at`. Si el lease vence sin
   * resultado (el proceso murió), otro worker la vuelve a reclamar.
   */
  DELIVERING = 'DELIVERING',
  /** El último intento falló con un error reintentable; el siguiente es en `next_attempt_at`. */
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  /** El destino respondió `2xx`. Estado final; lleva `delivered_at`. */
  DELIVERED = 'DELIVERED',
  /** Se agotaron los intentos automáticos. Sólo sale de aquí con un reintento manual. */
  FAILED = 'FAILED',
  /** Se descartó sin entregarse. Estado final. */
  CANCELLED = 'CANCELLED',
}
