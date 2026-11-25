import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';

import {
  PLAN_DESCRIPTION_MAX_LENGTH,
  PLAN_DESCRIPTIONS_MAX_ITEMS,
} from '../plan-descriptions.constants';

/**
 * Recorta los espacios de los extremos de cada elemento de texto del arreglo. Lo que no sea un
 * arreglo, o los elementos que no sean texto, se dejan tal cual para que la validación los
 * rechace con su propio mensaje en vez de convertirlos en silencio.
 *
 * @param params - Parámetros de `class-transformer`; sólo se usa `value`.
 * @returns El arreglo con sus textos recortados, o el valor original.
 * @throws Nunca lanza.
 *
 * @example
 * ```ts
 * trimDescriptions({ value: ['  Firma electrónica '] } as TransformFnParams);
 * // ['Firma electrónica']
 * ```
 */
export function trimDescriptions({ value }: TransformFnParams): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((item: unknown) =>
    typeof item === 'string' ? item.trim() : item,
  );
}

/**
 * Clave de comparación para detectar duplicados: sin distinguir mayúsculas y con los espacios
 * internos colapsados, porque "Firma  electrónica" y "firma electrónica" se leen igual en la
 * tarjeta.
 *
 * @param description - Descripción ya recortada.
 * @returns La clave normalizada.
 * @throws Nunca lanza.
 *
 * @example
 * ```ts
 * descriptionIdentity('Firma  Electrónica'); // 'firma electrónica'
 * ```
 */
export function descriptionIdentity(description: string): string {
  return description.replace(/\s+/g, ' ').toLocaleLowerCase('es-MX');
}

/**
 * Busca el PRIMER problema de una lista de descripciones, en el orden en que conviene contarlo:
 * forma (arreglo), tamaño, y luego cada elemento (tipo, vacío, longitud, repetido).
 *
 * Una sola causa por respuesta, y con el índice del elemento: con los validadores sueltos de
 * `class-validator`, un texto en lugar de arreglo devolvía además "elementos repetidos" y
 * "máximo 10 elementos", que no tienen nada que ver con el error real.
 *
 * @param value - `descriptions` tal como llegó (ya recortado por `trimDescriptions`).
 * @returns El mensaje del primer problema, o `null` si la lista es válida.
 * @throws Nunca lanza.
 *
 * @example
 * ```ts
 * findDescriptionsError(['Firma', '']);
 * // 'descriptions[1] no puede estar vacío.'
 * ```
 */
export function findDescriptionsError(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'descriptions debe ser un arreglo de textos.';
  }

  if (value.length > PLAN_DESCRIPTIONS_MAX_ITEMS) {
    return `descriptions admite como máximo ${PLAN_DESCRIPTIONS_MAX_ITEMS} elementos (llegaron ${value.length}).`;
  }

  const seen = new Map<string, number>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      return `descriptions[${index}] debe ser un texto.`;
    }
    if (item.length === 0) {
      return `descriptions[${index}] no puede estar vacío.`;
    }
    if (item.length > PLAN_DESCRIPTION_MAX_LENGTH) {
      return `descriptions[${index}] admite como máximo ${PLAN_DESCRIPTION_MAX_LENGTH} caracteres (tiene ${item.length}).`;
    }
    const key = descriptionIdentity(item);
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      return `descriptions[${index}] repite descriptions[${firstIndex}].`;
    }
    seen.set(key, index);
  }

  return null;
}

/**
 * Valida una lista de descripciones de plan con `findDescriptionsError`, devolviendo como
 * mensaje la causa concreta.
 *
 * @param options - Opciones de `class-validator` (no se usa `message`: lo arma la regla).
 * @returns El decorador de propiedad.
 * @throws Nunca lanza al decorar.
 *
 * @example
 * ```ts
 * class Dto { @IsPlanDescriptionList() descriptions: string[]; }
 * ```
 */
export function IsPlanDescriptionList(
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isPlanDescriptionList',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => findDescriptionsError(value) === null,
        defaultMessage: (args) =>
          findDescriptionsError(args?.value) ?? 'descriptions no es válido.',
      },
    });
  };
}

/**
 * `PATCH /api/v1/platform/plans/:planType/descriptions`.
 *
 * Reemplaza la lista completa: el orden del arreglo es el orden en que se muestran. Un arreglo
 * vacío deja el plan sin descripciones.
 *
 * @example
 * ```json
 * { "descriptions": ["Hasta 10 documentos", "Firma electrónica", "Soporte por correo"] }
 * ```
 */
export class UpdatePlanDescriptionsDto {
  @ApiProperty({
    type: [String],
    maxItems: PLAN_DESCRIPTIONS_MAX_ITEMS,
    example: ['Hasta 10 documentos', 'Firma electrónica', 'Soporte por correo'],
    description: `Beneficios del plan en orden de aparición. Máximo ${PLAN_DESCRIPTIONS_MAX_ITEMS} elementos, cada uno de 1 a ${PLAN_DESCRIPTION_MAX_LENGTH} caracteres, sin repetidos (sin distinguir mayúsculas ni espacios).`,
  })
  @Transform(trimDescriptions)
  @IsPlanDescriptionList()
  descriptions: string[];
}
