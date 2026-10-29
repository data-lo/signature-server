/**
 * Normaliza a ISO 8601 las fechas que la vista pública devuelve.
 *
 * El mismo campo llega como `Date` cuando viene de una columna de tipo fecha y como `string`
 * cuando se releyó de una columna jsonb (`advancedSignature.signedAt`). Una fecha inválida no
 * debe romper toda la respuesta: se prefiere omitir el renglón a devolver "Invalid Date".
 */
export function toIsoStringOrNull(
  value: Date | string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
