/**
 * Puerto hacia el dominio de verificación de identidad.
 *
 * El módulo `webhooks` sabe recibir, autenticar y registrar entregas; **no** sabe cuándo una
 * identidad queda aprobada. Ese juicio vive en `ProcessDiditVerificationResultUseCase`, del
 * módulo `identity-verification`, que todavía no existe en este repositorio.
 *
 * Para no bloquear el módulo central ni adivinar la forma de un caso de uso ajeno, la
 * delegación se expresa como este puerto: cuando `identity-verification` aterrice, basta con
 * que lo exporte atado a `DIDIT_VERIFICATION_PROCESSOR`:
 *
 * ```ts
 * providers: [
 *   ProcessDiditVerificationResultUseCase,
 *   {
 *     provide: DIDIT_VERIFICATION_PROCESSOR,
 *     useExisting: ProcessDiditVerificationResultUseCase,
 *   },
 * ],
 * exports: [DIDIT_VERIFICATION_PROCESSOR],
 * ```
 *
 * y que `WebhooksModule` importe ese módulo. Mientras nadie lo provea, la inyección es
 * `@Optional()` y el evento queda en RECEIVED (ver `ReceiveDiditWebhookUseCase`): el arranque
 * de la aplicación no depende de un módulo que aún no está.
 */
export const DIDIT_VERIFICATION_PROCESSOR = Symbol(
  'DIDIT_VERIFICATION_PROCESSOR',
);

export interface DiditVerificationProcessor {
  /**
   * Aplica el resultado de una sesión de verificación de Didit.
   *
   * Recibe el payload ya verificado tal cual lo mandó el proveedor: interpretar `status`,
   * `decision` o `vendor_data` es responsabilidad del dominio, no de este módulo.
   */
  execute(payload: Record<string, unknown>): Promise<void>;
}
