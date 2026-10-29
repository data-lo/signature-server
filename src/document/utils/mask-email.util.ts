/**
 * Oculta un correo dejando la primera letra y el dominio, para que el invitado reconozca a dónde
 * se le envió la invitación sin publicar el correo completo.
 *
 * @param email - Correo a ocultar.
 * @returns El correo enmascarado (`a***@empresa.com`), o `***` si no tiene forma de correo.
 *
 * @example
 * ```ts
 * maskEmail('ana.lopez@empresa.com'); // 'a***@empresa.com'
 * ```
 */
export function maskEmail(email: string): string {
  const [user, domain] = email.trim().split('@');
  if (!user || !domain) return '***';
  return `${user[0]}***@${domain}`;
}
