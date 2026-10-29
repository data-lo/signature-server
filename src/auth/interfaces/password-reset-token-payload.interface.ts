/**
 * Contenido del `resetToken` que emite `VerifyPasswordResetCodeUseCase` y consume
 * `ResetPasswordUseCase`. `purpose` lo distingue de un JWT de sesión, que va firmado con el
 * mismo secreto.
 */
export interface PasswordResetTokenPayload {
  sub: string;
  purpose: 'password_reset';
  iat?: number;
  exp?: number;
}
