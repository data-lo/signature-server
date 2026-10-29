/** Ver diagrama ER-V2, entidad "audit" — vocabulario de eventos del ciclo de vida del documento. */
export enum AUDIT_TYPE_ENUM {
  CREATED = 'created',
  PENDING = 'pending',
  APROVED_TO_SIGN = 'aproved_to_sign',
  SIGNATURES_PARTIAL = 'signatures_partial',
  SIGNATURES_COMPLETED = 'signatures_completed',
  REJECTED = 'rejected',
}
