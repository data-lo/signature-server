/**
 * Reemplaza a DOCUMENT_PARTICIPANT_ROLE_ENUM (SIGNER, SPECTATOR) — SPECTATOR se renombra a
 * WATCHER para coincidir con el diagrama ER-V2 (decisión confirmada, ver Fase 2 del plan de
 * migración). REVIEWER es nuevo: el dato ya se acepta aquí, pero todavía sin lógica de
 * aprobación/gateo del state machine (queda para una fase posterior si se necesita).
 *
 * Los valores van en MAYÚSCULAS desde la historia "Estandarizar enums signature_type y
 * collaborator_type": son el mismo texto que se persiste en `collaborators.colaborator_type` (ver
 * migración `UppercaseSignatureAndCollaboratorTypes`), el que sale en el campo `role` de los
 * participantes y el que compara `ParticipantRole` en el frontend. No confundir con
 * `PAYLOAD_COLABORATOR_TYPE_ENUM` (`SIGNER`/`WITNESS`), que es el vocabulario de ENTRADA del
 * payload de creación y ya estaba en mayúsculas.
 */
export enum COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  REVIEWER = 'REVIEWER',
  /**
   * Testigo: recibe copia y puede consultar el documento, pero no firma ni aprueba. Se llamaba
   * `WATCHER` hasta la historia "Renombrar rol Espectador a Testigo"; la migración
   * `RenameWatcherCollaboratorTypeToWitness` renombró la etiqueta en Postgres, así que las filas
   * existentes se leen como `WITNESS` sin reescribirse.
   */
  WITNESS = 'WITNESS',
}
