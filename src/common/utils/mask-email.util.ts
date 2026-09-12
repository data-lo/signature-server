/**
 * Enmascara un correo para mostrarlo en pantalla sin revelarlo completo (ver historia "Auth:
 * Flujo de Pre-registro, Verificación OTP y Control por CURP"): conserva el primer y último
 * carácter del local-part y el dominio intacto, p. ej. `usuario@dominio.com` -> `u***o@dominio.com`.
 */
export function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!domain || localPart.length === 0) {
    return email;
  }

  if (localPart.length === 1) {
    return `${localPart}***@${domain}`;
  }

  const first = localPart[0];
  const last = localPart[localPart.length - 1];
  return `${first}***${last}@${domain}`;
}
