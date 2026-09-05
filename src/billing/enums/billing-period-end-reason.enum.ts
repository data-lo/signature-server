/**
 * Por qué dejó de estar vigente un periodo del historial.
 *
 * ```
 * MANUAL_PERIOD_ENDED  se cumplió la fecha y nadie renovó; el cron devolvió el perfil a Free.
 * RENEWED              llegó un periodo nuevo que lo sustituye; el perfil siguió con servicio.
 * ```
 *
 * La distinción es la que hace legible el historial de un cliente: dos filas `EXPIRED` seguidas
 * significan cosas opuestas según esta columna —una cadena de `RENEWED` es un cliente que nunca
 * dejó de pagar, y un `MANUAL_PERIOD_ENDED` es el punto exacto en que se quedó sin plan—. Sin
 * ella habría que reconstruirlo comparando fechas entre filas.
 */
export enum BILLING_PERIOD_END_REASON_ENUM {
  MANUAL_PERIOD_ENDED = 'MANUAL_PERIOD_ENDED',
  RENEWED = 'RENEWED',
}
