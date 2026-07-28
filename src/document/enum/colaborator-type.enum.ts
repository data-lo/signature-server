/**
 * Reemplaza a DOCUMENT_PARTICIPANT_ROLE_ENUM (SIGNER, SPECTATOR) — SPECTATOR se renombra a
 * WATCHER para coincidir con el diagrama ER-V2 (decisión confirmada, ver Fase 2 del plan de
 * migración). REVIEWER es nuevo: el dato ya se acepta aquí, pero todavía sin lógica de
 * aprobación/gateo del state machine (queda para una fase posterior si se necesita).
 */
export enum COLABORATOR_TYPE_ENUM {
  SIGNER = 'signer',
  REVIEWER = 'reviewer',
  WATCHER = 'watcher',
}
