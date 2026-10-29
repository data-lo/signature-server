/**
 * Vocabulario comercial; ADVANCED corresponde a FIEL en el dominio de documentos.
 *
 * `BIOMETRIC` se llama igual en los dos vocabularios. Sólo etiqueta el recibo de crédito
 * (`document_credit_consumptions.signature_type`): un documento biométrico consume el mismo crédito
 * de documento que los demás.
 */
export enum BILLING_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
  BIOMETRIC = 'BIOMETRIC',
}
