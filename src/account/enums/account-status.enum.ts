/**
 * Placeholder confirmado con el equipo (ver Fase 2 del plan de migración ER-V2): el diagrama
 * objetivo solo mostraba "FIEL" para este enum, que parece un recorte/error de la imagen, no
 * un valor real. Espeja el ciclo de vida de membresía que ya existe hoy vía `isActive`,
 * extendido para cubrir invitaciones pendientes y suspensiones (sin flujo conectado todavía).
 */
export enum ACCOUNT_STATUS_ENUM {
  PENDING_INVITE = 'pending_invite',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  REMOVED = 'removed',
}
