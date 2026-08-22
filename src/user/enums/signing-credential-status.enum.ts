/**
 * Avance de la credencial de firma del usuario: el estado global que decide qué puede hacer
 * a continuación.
 *
 * Es **una sola variable** (`users.signing_credential_status`) y no una combinación de banderas
 * sueltas: antes había que cruzar "¿tiene identidad aprobada?" con "¿tiene firma PNG?" en cada
 * módulo que necesitara decidir, y cada uno podía equivocarse distinto. Acá el avance está
 * explícito y ordenado, y sólo se escribe desde `UpdateSigningCredentialStatusUseCase`.
 *
 * El frontend **lee** este estado para habilitar o deshabilitar pantallas; nunca lo escribe. La
 * bandera de conveniencia que consumía antes se deriva:
 *
 *     signingCredentialConfigured = signingCredentialStatus === CONFIGURED
 *
 * No se confunde con `users.is_configured`, que marca el fin del onboarding general (datos
 * personales) y no sabe nada de identidad validada.
 */
export enum SIGNING_CREDENTIAL_STATUS_ENUM {
  /** Estado inicial de todo usuario: nunca inició una verificación de identidad. */
  IDENTITY_VERIFICATION_REQUIRED = 'IDENTITY_VERIFICATION_REQUIRED',
  /** Hay una sesión de Didit abierta, pero el usuario todavía no empezó a capturar. */
  IDENTITY_VERIFICATION_PENDING = 'IDENTITY_VERIFICATION_PENDING',
  /** El usuario está dentro del flujo de Didit (INE, selfie, liveness). */
  IDENTITY_VERIFICATION_IN_PROGRESS = 'IDENTITY_VERIFICATION_IN_PROGRESS',
  /** Didit no pudo decidir automáticamente: queda en revisión manual del proveedor. */
  IDENTITY_VERIFICATION_IN_REVIEW = 'IDENTITY_VERIFICATION_IN_REVIEW',
  /** Rechazo, abandono o expiración: el usuario puede volver a intentarlo. */
  IDENTITY_VERIFICATION_RETRY_REQUIRED = 'IDENTITY_VERIFICATION_RETRY_REQUIRED',
  /** Bloqueo administrativo o error definitivo: el usuario NO puede reintentar solo. */
  IDENTITY_VERIFICATION_FAILED = 'IDENTITY_VERIFICATION_FAILED',
  /** Se agotaron los intentos permitidos de verificación. */
  IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED = 'IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED',
  /** Identidad aprobada: es el único estado en el que se acepta la firma PNG. */
  SIGNATURE_PENDING = 'SIGNATURE_PENDING',
  /** Identidad aprobada + firma PNG registrada: la credencial está lista para firmar. */
  CONFIGURED = 'CONFIGURED',
}
