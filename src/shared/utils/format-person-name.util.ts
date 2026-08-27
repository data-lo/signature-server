/**
 * Normaliza un nombre o apellido capturado en un formulario: cada palabra empieza con mayúscula
 * y el resto queda en minúscula, sin espacios sobrantes.
 *
 *     'juan pérez'        → 'Juan Pérez'
 *     'MARÍA DEL CARMEN'  → 'María Del Carmen'
 *     '  ana   lopez  '   → 'Ana Lopez'
 *
 * Sustituye al `toUpperCase()` que se aplicaba al guardar. Los nombres se veían gritados en
 * toda la aplicación —listados, correos, la hoja de firmas del PDF— y no había forma de
 * recuperar la capitalización original, porque se perdía en la escritura.
 *
 * **No trata las partículas como excepción.** 'DEL', 'DE', 'LA' quedan capitalizadas igual que
 * el resto ('María Del Carmen'), que es lo que pide la historia. Una lista de excepciones
 * parece más correcta pero acierta menos: 'de la Cruz' es correcto como apellido compuesto y
 * equivocado cuando 'De' abre el nombre, y ninguna regla automática distingue los dos casos sin
 * conocer al titular.
 *
 * Las conversiones son sensibles al idioma (`es-MX`) para no estropear acentos ni la ñ.
 *
 * Se aplica sólo a nombres y apellidos: CURP y RFC siguen guardándose en mayúsculas, que es su
 * forma canónica y la que usan las consultas.
 */
export function formatPersonName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('es-MX')
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (word) => `${word.charAt(0).toLocaleUpperCase('es-MX')}${word.slice(1)}`,
    )
    .join(' ');
}

/**
 * Igual que `formatPersonName`, pero conserva la ausencia de valor.
 *
 * Hay altas donde el nombre es opcional (ver `CreateUserDto`): devolver `''` en vez de
 * `undefined` escribiría una cadena vacía en la columna, que no es lo mismo que "no se capturó".
 */
export function formatOptionalPersonName(
  value: string | undefined | null,
): string | undefined {
  if (!value) {
    return undefined;
  }

  /**
   * Se normaliza primero y se decide después: un campo con puros espacios llega como cadena
   * "con contenido" pero no captura ningún nombre, así que tiene que quedar igual que uno vacío.
   */
  const formatted = formatPersonName(value);

  return formatted || undefined;
}
