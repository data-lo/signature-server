/** Distingue si el destinatario de una notificación tiene cuenta de plataforma (ACCOUNT) o fue invitado solo por email (WATCHER) — independiente de su colaboratorType (rol en el documento). */
export enum ACTOR_TYPE_ENUM {
  WATCHER = 'watcher',
  ACCOUNT = 'account',
}
