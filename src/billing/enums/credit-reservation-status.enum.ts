/** Vida de una reserva de créditos (`credit_reservations.status`). Sólo `ACTIVE` bloquea saldo. */
export enum CREDIT_RESERVATION_STATUS_ENUM {
  ACTIVE = 'ACTIVE',
  /** Se cobró: el crédito salió de `remaining`. */
  CONSUMED = 'CONSUMED',
  /** Se devolvió al saldo porque el proceso falló, se rechazó o se canceló. */
  RELEASED = 'RELEASED',
  /** Se devolvió al saldo porque venció sin resolverse (ver `ReleaseExpiredCreditReservationsUseCase`). */
  EXPIRED = 'EXPIRED',
}
