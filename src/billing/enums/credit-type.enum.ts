/**
 * Para qué sirve un crédito. Cada lote (`credit_lots.credit_type`) es de un solo tipo, y los saldos
 * de un perfil se cuentan por separado: un crédito biométrico no paga un documento ni al revés.
 */
export enum CREDIT_TYPE_ENUM {
  /** Crear un documento para firma (SIMPLE, ADVANCED o BIOMETRIC). */
  DOCUMENT_SIGNATURE = 'DOCUMENT_SIGNATURE',
  /** Un intento de firma biométrica con Didit. */
  BIOMETRIC_SIGNATURE = 'BIOMETRIC_SIGNATURE',
}
