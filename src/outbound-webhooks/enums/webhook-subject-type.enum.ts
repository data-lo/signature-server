/**
 * A quién pertenece la configuración de un webhook saliente (`webhook_endpoints.subject_type`).
 *
 * La relación con el sujeto es polimórfica y lógica: `subject_id` apunta a la tabla que indique
 * este tipo, sin FK. La aplicación valida que el sujeto exista y que quien configura el endpoint
 * tenga permiso sobre él. Agregar un tipo exige una migración que amplíe
 * `CHK_webhook_endpoints_subject_type`.
 */
export enum WEBHOOK_SUBJECT_TYPE_ENUM {
  /** `subject_id` es `organizations.id`. Único tipo aceptado por ahora. */
  ORGANIZATION = 'ORGANIZATION',
}
