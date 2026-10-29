/**
 * De dónde salieron los documentos de un lote. Determina además el ORDEN en que se gastan (ver
 * `ConsumeDocumentCreditUseCase`), que es la razón de que un lote arrastrado conserve su identidad
 * en vez de fundirse con el del periodo nuevo.
 */
export enum CREDIT_LOT_ORIGIN_ENUM {
  /** Los que concede el periodo facturado en curso. */
  CURRENT_PERIOD = 'CURRENT_PERIOD',
  /** Los del periodo anterior que no se gastaron y se arrastraron al siguiente. */
  ROLLOVER = 'ROLLOVER',
  /** Los comprados sueltos, fuera de la suscripción. */
  ADD_ON = 'ADD_ON',
  /**
   * Los de bienvenida del plan gratuito: se conceden UNA vez, al dar de alta el propietario, y no
   * se renuevan.
   *
   * Es un origen propio y no un `CURRENT_PERIOD` con importe cero porque no pertenece a ningún
   * periodo facturado: no lo emite ningún cobro, no se arrastra al siguiente mes y no aparece en
   * `subscription_billing_history`. Confundirlo con el del periodo haría que el rollover lo
   * reetiquetara y que cualquier conciliación buscara un cobro que no existe.
   */
  FREE_GRANT = 'FREE_GRANT',
}
