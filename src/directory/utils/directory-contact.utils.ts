/**
 * Normaliza el correo de un contacto: es la forma en la que se guarda y con la que se compara.
 *
 * @param email - Correo tal como llegó.
 * @returns El correo sin espacios en los extremos y en minúsculas.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * normalizeContactEmail('  Ana@Example.com '); // 'ana@example.com'
 * ```
 */
export function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normaliza el RFC de un contacto a mayúsculas, conservando `null` y `undefined`.
 *
 * @param taxId - RFC ya recortado por el DTO, `null` para vaciarlo o `undefined` si no vino.
 * @returns El RFC en mayúsculas, o el mismo `null`/`undefined`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * normalizeContactTaxId('gaaa900101xxx'); // 'GAAA900101XXX'
 * ```
 */
export function normalizeContactTaxId(
  taxId: string | null | undefined,
): string | null | undefined {
  return typeof taxId === 'string' ? taxId.toUpperCase() : taxId;
}

/**
 * Escapa los comodines de `LIKE` (`%`, `_` y `\`) para buscar el texto tal cual.
 *
 * @param term - Texto de búsqueda.
 * @returns El texto con los comodines escapados.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * escapeLikePattern('50%_off'); // '50\\%\\_off'
 * ```
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
