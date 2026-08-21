/** Alta de sesión ya normalizada: lo único que el dominio necesita de la respuesta de Didit. */
export interface DiditSession {
  /** `session_id` de Didit: la llave con la que el webhook encontrará el intento local. */
  sessionId: string;
  /** URL hospedada que el frontend abre o convierte en QR. */
  url: string;
  workflowId: string;
  expiresAt: Date | null;
  /**
   * Respuesta cruda del proveedor, sin los campos secretos. Se persiste en `provider_metadata`
   * para poder depurar un alta sin volver a llamar a Didit.
   */
  raw: Record<string, unknown>;
}
