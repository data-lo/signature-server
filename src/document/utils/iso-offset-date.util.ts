/**
 * Desfase con el que se imprimen las fechas de la constancia: hora del centro de México.
 *
 * Fijo y no tomado del runtime a propósito. Los contenedores corren en UTC, así que dejarlo al
 * entorno haría que el mismo documento se imprimiera con una hora distinta según dónde se generó
 * — y sin decir en cuál, porque el formato anterior no incluía la zona. En un documento legal la
 * fecha tiene que ser reproducible y explícita.
 */
const MEXICO_UTC_OFFSET_MINUTES = -6 * 60;

/**
 * Fecha en ISO 8601 con el desfase explícito: `2026-08-28T19:01:46.123-06:00`.
 *
 * `toISOString()` no sirve aquí porque siempre normaliza a UTC (`...Z`), que es justo lo que
 * confundía al leer la hoja: la constancia decía las 01:01 del día siguiente para un sellado
 * hecho a las 19:01. Con el desfase escrito, el instante es inequívoco y sigue siendo ISO.
 */
export function toIsoWithMexicoOffset(
  value: Date | string | null | undefined,
): string {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  // Se desplaza el instante para que los getters UTC devuelvan ya la hora local del desfase; el
  // sufijo lo declara, así que la marca sigue apuntando al mismo momento.
  const shifted = new Date(date.getTime() + MEXICO_UTC_OFFSET_MINUTES * 60_000);
  const absolute = Math.abs(MEXICO_UTC_OFFSET_MINUTES);
  const sign = MEXICO_UTC_OFFSET_MINUTES < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;

  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
      shifted.getUTCDate(),
    )}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
      shifted.getUTCSeconds(),
    )}` +
    `.${String(shifted.getUTCMilliseconds()).padStart(3, '0')}${offset}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
