/**
 * Condiciones comerciales fijas de una cuenta provisional Enterprise. Las decide el backend: el
 * request sólo puede elegir cuántos documentos, el periodo y el folio.
 */

/** Plan con el que se factura el periodo manual; habilita `API_INTEGRATION`. */
export const PROVISIONED_PLAN_TYPE = 'enterprise';

/** Nombre con el que se crea la fila de `plans` si el entorno no la tiene sincronizada. */
export const PROVISIONED_PLAN_NAME = 'Enterprise';

/**
 * Documentos por periodo con los que se crea la fila de `plans` si falta. No es lo que se acredita
 * (eso es `documentsGranted`, siempre explícito); `CHK_plans_documents_included` sólo prohíbe 0.
 */
export const PROVISIONED_PLAN_DOCUMENTS_INCLUDED = 1;

/** Documentos que se acreditan si el request no dice otra cosa. */
export const DEFAULT_PROVISIONED_DOCUMENTS_GRANTED = 1600;

/** Tope de documentos por aprovisionamiento: acota un error de dedo del operador. */
export const MAX_PROVISIONED_DOCUMENTS_GRANTED = 100_000;

/** Importe del periodo manual: es una cuenta de pruebas, no un cobro. */
export const PROVISIONED_PERIOD_AMOUNT = 0;

/** Moneda del periodo manual. */
export const PROVISIONED_PERIOD_CURRENCY = 'mxn';
