/**
 * Control administrativo de la API de integración de una organización
 * (`integration_settings.status`, tipo `integration_status_enum`).
 *
 * Es adicional a la capacidad de plan `API_INTEGRATION`: el plan dice si la organización puede
 * integrarse, y este estado si su administrador quiere que lo haga ahora.
 */
export enum INTEGRATION_STATUS_ENUM {
  /** La API key autentica con normalidad. */
  ACTIVE = 'ACTIVE',
  /**
   * `OrganizationApiKeyGuard` rechaza toda petición nueva con `403 INTEGRATION_DISABLED`. Las API
   * keys no se tocan: al reactivar vuelven a funcionar las mismas.
   */
  DISABLED = 'DISABLED',
}
