import { BadRequestException, Injectable } from '@nestjs/common';

import {
  COMMON_PASSWORDS,
  KEYBOARD_ROWS,
  PREDICTABLE_BASE_WORDS,
} from './common-passwords';

/** Mínimo de caracteres de una contraseña nueva (code points, no unidades UTF-16). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Cuánto tiene que quedar de una contraseña después de descontarle las piezas previsibles. Con
 * menos, lo que la sostiene es una palabra o un patrón adivinable con un par de números o
 * símbolos alrededor (`Password123!` deja `!`).
 */
const MIN_UNPREDICTABLE_LENGTH = 6;

/** Tramos de teclado o de secuencia a partir de los que se consideran previsibles. */
const MIN_KEYBOARD_RUN = 4;
const MIN_SEQUENCE_RUN = 3;

/**
 * Único mensaje que ve el cliente, sea cual sea la regla que falló: revelar cuál fue orientaría a
 * quien prueba contraseñas.
 */
export const WEAK_PASSWORD_MESSAGE =
  'La contraseña es demasiado común o fácil de adivinar. Elige una contraseña más segura.';

/** Escapa un literal para usarlo dentro de una expresión regular. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Palabras base, de la más larga a la más corta para que `password` gane a `pass`. */
const BASE_WORDS_PATTERN = new RegExp(
  [...PREDICTABLE_BASE_WORDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|'),
  'gu',
);

/** Todos los tramos de 4 o más teclas seguidas de cada fila, en los dos sentidos. */
const KEYBOARD_RUNS_PATTERN = new RegExp(
  [
    ...new Set(
      KEYBOARD_ROWS.flatMap((row) => {
        const runs: string[] = [];
        for (const line of [row, [...row].reverse().join('')]) {
          const keys = [...line];
          for (let start = 0; start < keys.length; start += 1) {
            for (
              let end = start + MIN_KEYBOARD_RUN;
              end <= keys.length;
              end += 1
            ) {
              runs.push(keys.slice(start, end).join(''));
            }
          }
        }
        return runs;
      }),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|'),
  'gu',
);

/** Años de 1900 a 2099: el sufijo más común después de los números seguidos. */
const YEAR_PATTERN = /(?:19|20)\d{2}/gu;

/** Un mismo carácter tres o más veces seguidas (`aaa`, `111`, `!!!`). */
const REPEATED_CHARACTER_PATTERN = /(.)\1{2,}/gu;

/** La contraseña entera es un bloque corto repetido (`abcabcabcabc`, `xk9qxk9qxk9q`). */
const REPEATED_BLOCK_PATTERN = /^(.{1,6})\1+$/u;

/**
 * Quita los tramos de 3 o más letras o dígitos consecutivos, ascendentes o descendentes
 * (`abc`, `123`, `987`).
 */
function removeSequences(value: string): string {
  const chars = [...value];
  const keep = chars.map(() => true);
  const isSequenceChar = (c: string) => /[a-z0-9]/.test(c);

  let start = 0;
  while (start < chars.length) {
    let end = start;
    let step = 0;
    while (end + 1 < chars.length) {
      const current = chars[end];
      const next = chars[end + 1];
      if (!isSequenceChar(current) || !isSequenceChar(next)) break;
      const diff = next.charCodeAt(0) - current.charCodeAt(0);
      const sameClass = /\d/.test(current) === /\d/.test(next);
      if (!sameClass || Math.abs(diff) !== 1 || (step !== 0 && diff !== step)) {
        break;
      }
      step = diff;
      end += 1;
    }
    if (end - start + 1 >= MIN_SEQUENCE_RUN) {
      for (let i = start; i <= end; i += 1) keep[i] = false;
    }
    start = end + 1;
  }

  return chars.filter((_, i) => keep[i]).join('');
}

/**
 * Decide si una contraseña nueva puede usarse (registro, cambio y restablecimiento). Generar y
 * comparar hashes sigue siendo de `PasswordService`; esto sólo dice sí o no, antes de hashear.
 *
 * La política depende de longitud y de resistencia a contraseñas comunes o predecibles, no de
 * reglas de composición ("una mayúscula y un símbolo"): una frase larga y propia es válida aunque
 * sea toda en minúsculas, y `Password123!` no lo es aunque cumpla cualquier regla de composición.
 *
 * - Todo se evalúa localmente: la contraseña nunca sale del proceso.
 * - Sólo se normaliza a minúsculas para comparar; lo que se guarda es la contraseña original, sin
 *   transformar ni truncar.
 * - Nunca se escribe la contraseña ni su versión normalizada en logs, eventos ni respuestas.
 */
@Injectable()
export class PasswordPolicyService {
  /**
   * Valida una contraseña nueva contra la política y lanza si no la cumple.
   *
   * Rechaza si tiene menos de `PASSWORD_MIN_LENGTH` caracteres, si está en `COMMON_PASSWORDS`, si
   * es un bloque corto repetido, o si al descontarle sus piezas previsibles —palabras base
   * comunes, tramos del teclado, secuencias, años y caracteres repetidos— quedan menos de 6.
   *
   * @param password - Contraseña tal como la escribió el usuario.
   * @returns Nada; si vuelve, la contraseña es válida.
   *
   * @throws {BadRequestException} (400) Con `WEAK_PASSWORD_MESSAGE`, sin decir qué regla falló.
   *
   * @example
   * ```ts
   * passwordPolicy.assertValid('Password123!'); // lanza BadRequestException
   * passwordPolicy.assertValid('mi gato duerme en la azotea'); // válida
   * ```
   */
  assertValid(password: string): void {
    if (!this.isAcceptable(password)) {
      throw new BadRequestException(WEAK_PASSWORD_MESSAGE);
    }
  }

  /**
   * Aplica las reglas de la política. Privado a propósito: el resultado sólo sale como la
   * excepción genérica de `assertValid`.
   *
   * @param password - Contraseña original.
   * @returns `true` si cumple todas las reglas.
   */
  private isAcceptable(password: string): boolean {
    if (typeof password !== 'string') return false;
    if ([...password].length < PASSWORD_MIN_LENGTH) return false;

    const normalized = password.toLowerCase();
    if (COMMON_PASSWORDS.has(normalized)) return false;
    if (REPEATED_BLOCK_PATTERN.test(normalized)) return false;

    const unpredictable = removeSequences(
      normalized
        .replace(BASE_WORDS_PATTERN, '')
        .replace(KEYBOARD_RUNS_PATTERN, '')
        .replace(YEAR_PATTERN, '')
        .replace(REPEATED_CHARACTER_PATTERN, ''),
    );

    return [...unpredictable].length >= MIN_UNPREDICTABLE_LENGTH;
  }
}
