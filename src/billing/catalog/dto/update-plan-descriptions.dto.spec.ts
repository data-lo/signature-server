import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  PLAN_DESCRIPTION_MAX_LENGTH,
  PLAN_DESCRIPTIONS_MAX_ITEMS,
} from '../plan-descriptions.constants';
import { UpdatePlanDescriptionsDto } from './update-plan-descriptions.dto';

/**
 * Valida el body como lo hace el `ValidationPipe` global (`transform: true`) y devuelve los
 * mensajes de error, o la instancia si es válido.
 *
 * @param body - Body crudo de la petición.
 * @returns Mensajes de error y la instancia transformada.
 *
 * @example
 * const { errors } = await check({ descriptions: [] });
 */
async function check(body: unknown) {
  const dto = plainToInstance(UpdatePlanDescriptionsDto, body);
  const errors = await validate(dto, { whitelist: true });
  return {
    dto,
    errors: errors.flatMap((error) => Object.values(error.constraints ?? {})),
  };
}

describe('UpdatePlanDescriptionsDto', () => {
  it('acepta la lista del ejemplo y conserva su orden', async () => {
    const descriptions = [
      'Hasta 10 documentos',
      'Firma electrónica',
      'Soporte por correo',
    ];

    const { dto, errors } = await check({ descriptions });

    expect(errors).toEqual([]);
    expect(dto.descriptions).toEqual(descriptions);
  });

  it('acepta una lista vacía: un plan puede no tener descripciones', async () => {
    const { errors } = await check({ descriptions: [] });

    expect(errors).toEqual([]);
  });

  it('recorta los espacios de los extremos de cada descripción', async () => {
    const { dto, errors } = await check({
      descriptions: ['  Firma electrónica  '],
    });

    expect(errors).toEqual([]);
    expect(dto.descriptions).toEqual(['Firma electrónica']);
  });

  it.each([
    ['falta', {}, 'descriptions debe ser un arreglo de textos.'],
    [
      'no es un arreglo',
      { descriptions: 'Firma electrónica' },
      'descriptions debe ser un arreglo de textos.',
    ],
    [
      'tiene elementos que no son texto',
      { descriptions: ['Firma', 3] },
      'descriptions[1] debe ser un texto.',
    ],
    [
      'tiene un texto vacío',
      { descriptions: ['Firma', ''] },
      'descriptions[1] no puede estar vacío.',
    ],
    [
      'tiene un texto con sólo espacios',
      { descriptions: ['   '] },
      'descriptions[0] no puede estar vacío.',
    ],
    [
      'repite un elemento',
      { descriptions: ['Firma electrónica', 'Firma electrónica'] },
      'descriptions[1] repite descriptions[0].',
    ],
    [
      'repite un elemento con otras mayúsculas o espacios',
      { descriptions: ['Firma electrónica', 'Soporte', ' firma  ELECTRÓNICA'] },
      'descriptions[2] repite descriptions[0].',
    ],
    [
      `supera ${PLAN_DESCRIPTIONS_MAX_ITEMS} elementos`,
      {
        descriptions: Array.from(
          { length: PLAN_DESCRIPTIONS_MAX_ITEMS + 1 },
          (_, index) => `Beneficio ${index}`,
        ),
      },
      `descriptions admite como máximo ${PLAN_DESCRIPTIONS_MAX_ITEMS} elementos (llegaron ${PLAN_DESCRIPTIONS_MAX_ITEMS + 1}).`,
    ],
    [
      `tiene un texto de más de ${PLAN_DESCRIPTION_MAX_LENGTH} caracteres`,
      { descriptions: ['a'.repeat(PLAN_DESCRIPTION_MAX_LENGTH + 1)] },
      `descriptions[0] admite como máximo ${PLAN_DESCRIPTION_MAX_LENGTH} caracteres (tiene ${PLAN_DESCRIPTION_MAX_LENGTH + 1}).`,
    ],
  ])(
    'rechaza el body cuando descriptions %s, con UNA causa clara',
    async (_, body, message) => {
      const { errors } = await check(body);

      expect(errors).toEqual([message]);
    },
  );

  it(`acepta exactamente ${PLAN_DESCRIPTIONS_MAX_ITEMS} elementos de ${PLAN_DESCRIPTION_MAX_LENGTH} caracteres`, async () => {
    const descriptions = Array.from(
      { length: PLAN_DESCRIPTIONS_MAX_ITEMS },
      (_, index) => `${index}`.padEnd(PLAN_DESCRIPTION_MAX_LENGTH, 'x'),
    );

    const { errors } = await check({ descriptions });

    expect(errors).toEqual([]);
  });
});
