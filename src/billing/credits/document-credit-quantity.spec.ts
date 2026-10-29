import { InvalidDocumentCreditQuantityException } from '../exceptions/billing.exceptions';
import {
  MAX_DOCUMENT_CREDITS_PER_PURCHASE,
  assertValidDocumentCreditQuantity,
} from './document-credit-quantity';

/**
 * Captura lo que lanza la validación para poder inspeccionar la respuesta HTTP que produciría.
 *
 * @param quantity - Cantidad a validar.
 * @returns La excepción lanzada, o `undefined` si la cantidad era válida.
 *
 * @example
 * const error = thrownBy(0); // InvalidDocumentCreditQuantityException
 */
function thrownBy(quantity: number): unknown {
  try {
    assertValidDocumentCreditQuantity(quantity);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('assertValidDocumentCreditQuantity', () => {
  it('fija el máximo inicial en 100 documentos por compra', () => {
    expect(MAX_DOCUMENT_CREDITS_PER_PURCHASE).toBe(100);
  });

  it.each([
    ['una sola unidad', 1],
    ['varias unidades', 5],
    ['el máximo permitido', MAX_DOCUMENT_CREDITS_PER_PURCHASE],
  ])('acepta %s', (_caso, quantity) => {
    expect(thrownBy(quantity)).toBeUndefined();
  });

  it.each([
    ['cero', 0, 'Debes seleccionar al menos un documento.'],
    ['negativa', -3, 'Debes seleccionar al menos un documento.'],
    ['decimal', 2.5, 'La cantidad debe ser un número entero.'],
    ['NaN', Number.NaN, 'La cantidad debe ser un número entero.'],
    [
      'superior al máximo',
      MAX_DOCUMENT_CREDITS_PER_PURCHASE + 1,
      'Puedes comprar máximo 100 documentos.',
    ],
  ])('rechaza una cantidad %s', (_caso, quantity, message) => {
    const error = thrownBy(quantity);

    expect(error).toBeInstanceOf(InvalidDocumentCreditQuantityException);
    expect((error as Error).message).toBe(message);
  });

  /**
   * Es lo que deja al formulario pintar el mensaje debajo del selector de cantidad con
   * `setError('quantity', ...)` sin adivinarlo por el texto.
   */
  it('responde un 400 que dice a qué campo pertenece y cuál es el máximo', () => {
    const error = thrownBy(0) as InvalidDocumentCreditQuantityException;

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      message: 'Debes seleccionar al menos un documento.',
      error: 'Bad Request',
      field: 'quantity',
      maxQuantity: MAX_DOCUMENT_CREDITS_PER_PURCHASE,
    });
  });
});
