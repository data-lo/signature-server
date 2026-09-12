import { InvalidDocumentCreditQuantityException } from '../exceptions/billing.exceptions';

/**
 * Máximo de unidades de una misma oferta que se pueden comprar en un solo Checkout.
 *
 * Es una regla comercial, no un límite técnico de Stripe: existe para que un error de tecleo (un
 * `1000` en vez de `10`) no termine en un cargo que habría que reembolsar. Vive en una constante
 * y no en la base porque hoy no depende del plan; si algún día dependiera, éste es el único sitio
 * que lo resuelve.
 *
 * El frontend tiene su propia copia (`MAX_DOCUMENT_CREDITS_PER_PURCHASE` en `signature-app`) sólo
 * para avisar antes de enviar; **la que decide es ésta**.
 */
export const MAX_DOCUMENT_CREDITS_PER_PURCHASE = 100;

/**
 * Comprueba que la cantidad pedida en una compra de documentos sea un entero entre 1 y el máximo.
 *
 * Se valida en el caso de uso y no sólo en el DTO a propósito: la cantidad multiplica el importe
 * que se cobra y los créditos que se emiten, así que la regla tiene que valer para cualquier
 * llamador, no sólo para el endpoint HTTP. El DTO se limita a garantizar que llegue un número.
 *
 * Los mensajes son los mismos que muestra el formulario del frontend, para que el usuario lea lo
 * mismo lo haya detectado quien lo haya detectado.
 *
 * @param quantity - Unidades de la oferta que se quieren comprar, tal como llegaron.
 * @returns Nada; si la cantidad es válida, la función simplemente regresa.
 *
 * @throws {InvalidDocumentCreditQuantityException} Si no es un entero, es menor que 1 o supera
 *   `MAX_DOCUMENT_CREDITS_PER_PURCHASE`.
 *
 * @example
 * ```ts
 * assertValidDocumentCreditQuantity(5); // regresa sin lanzar
 * assertValidDocumentCreditQuantity(2.5); // lanza InvalidDocumentCreditQuantityException
 * ```
 */
export function assertValidDocumentCreditQuantity(quantity: number): void {
  if (!Number.isInteger(quantity)) {
    throw new InvalidDocumentCreditQuantityException(
      'La cantidad debe ser un número entero.',
      MAX_DOCUMENT_CREDITS_PER_PURCHASE,
    );
  }

  if (quantity < 1) {
    throw new InvalidDocumentCreditQuantityException(
      'Debes seleccionar al menos un documento.',
      MAX_DOCUMENT_CREDITS_PER_PURCHASE,
    );
  }

  if (quantity > MAX_DOCUMENT_CREDITS_PER_PURCHASE) {
    throw new InvalidDocumentCreditQuantityException(
      `Puedes comprar máximo ${MAX_DOCUMENT_CREDITS_PER_PURCHASE} documentos.`,
      MAX_DOCUMENT_CREDITS_PER_PURCHASE,
    );
  }
}
