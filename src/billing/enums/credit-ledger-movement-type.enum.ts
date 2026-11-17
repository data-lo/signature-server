/**
 * Qué le hizo un movimiento del ledger (`credit_ledger_entries`) al lote. La cantidad siempre es
 * positiva; el tipo decide el sentido:
 *
 * | Movimiento | `remaining` | `reserved` |
 * | --- | --- | --- |
 * | `PURCHASE`, `GRANT`, `REFUND` | `+ quantity` | — |
 * | `RESERVE` | — | `+ quantity` |
 * | `CONSUME` con reserva | `- quantity` | `- quantity` |
 * | `CONSUME` sin reserva (consumo inmediato) | `- quantity` | — |
 * | `RELEASE` | — | `- quantity` |
 *
 * `ADJUSTMENT` queda reservado para correcciones manuales: hoy nadie lo escribe.
 */
export enum CREDIT_LEDGER_MOVEMENT_TYPE_ENUM {
  /** Créditos pagados: compra suelta o periodo de suscripción. */
  PURCHASE = 'PURCHASE',
  /** Créditos sin cobro de por medio: bienvenida del plan gratuito o recarga de plataforma. */
  GRANT = 'GRANT',
  RESERVE = 'RESERVE',
  CONSUME = 'CONSUME',
  RELEASE = 'RELEASE',
  REFUND = 'REFUND',
  ADJUSTMENT = 'ADJUSTMENT',
}
