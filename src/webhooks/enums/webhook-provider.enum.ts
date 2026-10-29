/**
 * Proveedores externos que entregan webhooks a este servidor.
 *
 * El valor persistido es el nombre en mayúsculas porque así lo define el esquema de
 * `webhook_events` (`DIDIT | STRIPE`); es también la mitad de la clave de idempotencia
 * `UNIQUE(provider, provider_event_id)`, así que dos proveedores pueden usar el mismo
 * identificador de evento sin colisionar.
 */
export enum WEBHOOK_PROVIDER_ENUM {
  DIDIT = 'DIDIT',
  STRIPE = 'STRIPE',
}
