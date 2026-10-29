/**
 * Estado de un intento de verificación de identidad.
 *
 * Es el vocabulario propio del dominio, no el de Didit: el mapeo desde los estados del
 * proveedor vive en `ProcessDiditVerificationResultUseCase`. Así, cuando Didit renombre un
 * estado o entre un segundo proveedor, cambia el mapeo y no la tabla ni el frontend.
 *
 * Sólo APPROVED habilita subir la firma PNG. Todos los demás — incluido IN_REVIEW — son
 * estados en los que el usuario todavía no puede firmar.
 */
export enum IDENTITY_VERIFICATION_STATUS_ENUM {
  /** Intento creado localmente; la sesión de Didit todavía no se abrió. */
  PENDING = 'PENDING',
  /** El usuario está capturando INE/selfie dentro del flujo hospedado. */
  IN_PROGRESS = 'IN_PROGRESS',
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
  /** Didit no pudo decidir automáticamente; queda en revisión manual del proveedor. */
  IN_REVIEW = 'IN_REVIEW',
  /** El usuario abandonó el flujo sin terminarlo. */
  ABANDONED = 'ABANDONED',
  EXPIRED = 'EXPIRED',
  /** Error del proveedor o estado desconocido: el intento no sirve y hay que reiniciarlo. */
  FAILED = 'FAILED',
}
