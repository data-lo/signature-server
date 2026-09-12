import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDocumentCreditCheckoutDto } from './create-document-credit-checkout.dto';

const CATALOG_PRICE_ID = '7f3c1f6e-2b4a-4c8d-9e15-0a1b2c3d4e5f';

/**
 * Valida un cuerpo como lo haría el `ValidationPipe` global y devuelve qué propiedades rechaza.
 *
 * @param body - Cuerpo JSON tal como llegaría a la petición.
 * @returns Las propiedades con errores; vacío si el cuerpo pasa.
 *
 * @example
 * await rejectedProperties({ catalogPriceId: CATALOG_PRICE_ID, quantity: '5' }); // ['quantity']
 */
async function rejectedProperties(
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(
    plainToInstance(CreateDocumentCreditCheckoutDto, body),
  );

  return errors.map((error) => error.property);
}

describe('CreateDocumentCreditCheckoutDto', () => {
  it('acepta el id del catálogo con una cantidad numérica', async () => {
    await expect(
      rejectedProperties({ catalogPriceId: CATALOG_PRICE_ID, quantity: 5 }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['como texto', '5'],
    ['ausente', undefined],
    ['NaN', Number.NaN],
    ['infinita', Number.POSITIVE_INFINITY],
  ])('rechaza una cantidad %s', async (_caso, quantity) => {
    await expect(
      rejectedProperties({ catalogPriceId: CATALOG_PRICE_ID, quantity }),
    ).resolves.toEqual(['quantity']);
  });

  /**
   * El rango y el entero NO son del DTO a propósito: los decide el caso de uso, que responde con
   * `field: 'quantity'`. Si el DTO los rechazara antes, el formulario recibiría una lista de textos
   * sin campo y no podría asociar el error al selector.
   */
  it.each([
    ['cero', 0],
    ['decimal', 2.5],
    ['superior al máximo', 101],
  ])(
    'deja pasar una cantidad %s para que la rechace el caso de uso',
    async (_caso, quantity) => {
      await expect(
        rejectedProperties({ catalogPriceId: CATALOG_PRICE_ID, quantity }),
      ).resolves.toEqual([]);
    },
  );
});
