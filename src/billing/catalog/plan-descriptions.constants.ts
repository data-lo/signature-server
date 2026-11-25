/**
 * Límites de `plans.descriptions`.
 *
 * Diez renglones de 160 caracteres caben en una tarjeta de plan sin que la lista se convierta
 * en un texto corrido; más que eso es contenido para una página de detalle, no para el catálogo.
 *
 * @example
 * ```ts
 * descriptions.length <= PLAN_DESCRIPTIONS_MAX_ITEMS;
 * ```
 */
export const PLAN_DESCRIPTIONS_MAX_ITEMS = 10;

/** Longitud máxima de cada descripción, ya recortados los espacios de los extremos. */
export const PLAN_DESCRIPTION_MAX_LENGTH = 160;
