/**
 * Palabras de un nombre para compararlo: sin acentos, en mayúsculas y separado por cualquier cosa
 * que no sea letra (espacios, guiones, puntos). "José-Ángel  López" → ['JOSE', 'ANGEL', 'LOPEZ'].
 *
 * @param text - Nombre tal como llegó.
 * @returns Sus palabras normalizadas, sin vacías.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * nameTokens('María de la Luz Pérez'); // ['MARIA', 'DE', 'LA', 'LUZ', 'PEREZ']
 * ```
 */
export function nameTokens(text: string | null | undefined): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-ZÑ]+/)
    .filter(Boolean);
}

/**
 * Indica si un nombre leído de un documento de identidad o de un certificado corresponde a la
 * persona esperada: TODAS las palabras del nombre esperado tienen que aparecer en el leído, en
 * cualquier orden. Así "Ana López" corresponde a "ANA LOPEZ PEREZ" (INE con segundo apellido) o a
 * "LOPEZ PEREZ ANA" (orden del SAT), pero no a "ANA LOPEZ" si se esperaba "Ana Martínez".
 *
 * Un nombre esperado vacío nunca corresponde: sin datos no se puede confirmar a nadie.
 *
 * @param expected - Nombre que se espera (el del colaborador o del usuario provisional).
 * @param actual - Nombre leído (Didit o el CN del certificado).
 * @returns `true` si corresponde.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * personNameMatches('Ana López', 'LOPEZ PEREZ ANA'); // true
 * personNameMatches('Ana López', 'ANA MARTINEZ'); // false
 * ```
 */
export function personNameMatches(
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  const wanted = nameTokens(expected);
  if (wanted.length === 0) return false;
  const read = new Set(nameTokens(actual));
  return wanted.every((token) => read.has(token));
}
