/**
 * En qué quedó un periodo del historial.
 *
 * ```
 * ACTIVE    el periodo vigente; el que habilita el servicio ahora mismo
 * CANCELED  terminó porque alguien lo canceló (programado o de inmediato)
 * EXPIRED   terminó sin que nadie lo pidiera: el cobro falló y Stripe lo dio de baja
 * ```
 *
 * **La diferencia entre `CANCELED` y `EXPIRED` es voluntad, no forma.** Los dos dejan al cliente
 * sin plan y desde fuera se parecen, pero separan a quien decidió irse de quien se quedó fuera
 * por un cobro fallido — que son públicos opuestos: al primero se le pregunta por qué se fue, al
 * segundo se le pide actualizar la tarjeta. El motivo concreto vive en `ended_reason`; esto es la
 * categoría con la que se cuentan.
 */
export enum SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM {
  ACTIVE = 'ACTIVE',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
}
