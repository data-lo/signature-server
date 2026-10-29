/**
 * Resultado de una de las comprobaciones individuales que hace el proveedor dentro de una
 * verificación (lectura del documento, coincidencia facial, prueba de vida).
 *
 * Es vocabulario propio, no el de Didit: el proveedor usa `match`/`no_match` para el rostro,
 * `live`/`not_live` para el liveness y `Approved`/`Declined` para el documento. Unificarlo acá
 * permite que la pantalla muestre las tres comprobaciones con el mismo lenguaje y que un cambio
 * de proveedor no llegue al frontend.
 */
export enum IDENTITY_CHECK_OUTCOME_ENUM {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  /** El proveedor no pudo decidir automáticamente esta comprobación. */
  IN_REVIEW = 'IN_REVIEW',
}
