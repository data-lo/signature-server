/**
 * En qué punto de su ciclo de vida está un usuario.
 *
 * - `ACTIVE`: se registró él mismo (pre-registro con CURP, contraseña y correo verificado) o ya
 *   completó su alta. Es el estado de todo usuario anterior a esta columna.
 * - `PROVISIONED`: lo creó una integración por API key al recibir un documento a su nombre
 *   (`IntegrationCreatorService`). Sólo tiene nombre y correo: le faltan CURP, contraseña y ficha
 *   personal, y por eso no puede iniciar sesión con contraseña (`LoginUseCase`).
 *
 * `CHK_users_active_has_credentials` (migración `AddLifecycleStatusToUsers`) exige que un usuario
 * `ACTIVE` tenga los tres datos; un `PROVISIONED` los puede tener nulos.
 */
export enum USER_LIFECYCLE_STATUS_ENUM {
  PROVISIONED = 'PROVISIONED',
  ACTIVE = 'ACTIVE',
}
