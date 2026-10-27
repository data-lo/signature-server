/**
 * Ciclo de vida de una API key de organización.
 *
 * - `ACTIVE`: la llave vigente. La base admite a lo sumo una por organización
 *   (`uq_api_keys_one_active_per_organization`).
 * - `REVOKED`: una llave dada de baja. No se borra: se conserva como historial y auditoría, y deja
 *   libre el lugar de la vigente.
 *
 * Que una llave `ACTIVE` haya pasado su `expiresAt` no cambia su estado: vencer es una condición
 * que se evalúa al usarla, no una transición guardada.
 */
export enum ApiKeyStatusEnum {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}
