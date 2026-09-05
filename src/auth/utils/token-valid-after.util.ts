/**
 * Resuelve el nombre de la key de Redis que invalida en bloque todos los JWT emitidos antes de
 * cierto momento para un usuario, y es su único punto de verdad.
 *
 * La escribe `AuthService.resetPassword`, fijándola a "ahora" tras un reset exitoso, y la leen tanto
 * `JwtAuthGuard` —para cualquier JWT de sesión— como el propio `resetPassword`, para que el
 * `resetToken` no pueda reusarse una vez consumido.
 */
export function tokenValidAfterKey(userId: string): string {
  return `token_valid_after:${userId}`;
}
