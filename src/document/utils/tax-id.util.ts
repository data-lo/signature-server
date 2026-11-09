/** Forma de un RFC de persona física (13) o moral (12), ya normalizado. */
export const RFC_FORMAT = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

/**
 * Deja un RFC en su forma comparable: sin espacios y en mayúsculas.
 *
 * @param value - RFC tal como se capturó o como lo trae el certificado.
 * @returns El RFC normalizado.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * normalizeTaxId(' peaj 800101 abc '); // 'PEAJ800101ABC'
 * ```
 */
export function normalizeTaxId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}
