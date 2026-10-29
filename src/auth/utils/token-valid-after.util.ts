/**
 * Único punto de verdad para el nombre de la key de Redis que invalida en bloque todos los
 * JWT emitidos antes de cierto momento para un usuario (ver historia "Recuperación de
 * Contraseña mediante Código de Verificación OTP"). La escribe `AuthService.resetPassword`
 * (fija el valor a "ahora" tras un reset exitoso) y la leen tanto `JwtAuthGuard` (para
 * cualquier JWT de sesión normal) como `AuthService.resetPassword` mismo (para que el propio
 * `resetToken` no pueda reusarse tras haberse consumido una vez).
 */
export function tokenValidAfterKey(userId: string): string {
  return `token_valid_after:${userId}`;
}
