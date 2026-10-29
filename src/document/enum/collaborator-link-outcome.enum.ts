/**
 * Resultado de pedir la vinculación de la cuenta autenticada a una invitación concreta
 * (`PATCH /document/:id/link-collaborator` con `collaboratorId`).
 *
 * Sólo `LINKED` y `ALREADY_LINKED` confirman que la cuenta ES el firmante: el frontend no manda al
 * dashboard privado con ningún otro.
 */
export enum COLLABORATOR_LINK_OUTCOME_ENUM {
  /** Se vinculó en esta petición. */
  LINKED = 'LINKED',
  /** Ya estaba vinculada a esta misma cuenta (p. ej., el usuario vuelve a abrir el enlace). */
  ALREADY_LINKED = 'ALREADY_LINKED',
  /**
   * La cuenta no corresponde a la invitación: el correo verificado es otro, o el colaborador ya
   * está vinculado a otra cuenta. No se modificó nada.
   */
  ACCOUNT_MISMATCH = 'ACCOUNT_MISMATCH',
  /** La cuenta coincide, pero el firmante ya respondió y una invitación resuelta no se reasigna. */
  NOT_AVAILABLE = 'NOT_AVAILABLE',
}
