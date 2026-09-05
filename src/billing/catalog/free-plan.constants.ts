/**
 * El plan gratuito, que existe SÓLO en esta base de datos.
 *
 * No tiene producto ni precio en Stripe, y por eso no aparece en `GET /payments/services` (ver
 * `GetPublicStripePlansUseCase`, que lista el catálogo del proveedor) ni se puede contratar por
 * Checkout. Es la fila de `plans` a la que apunta el `current_plan_type` de todo perfil recién
 * creado.
 *
 * Vive como constante y no como enum porque `plans.plan_type` es un catálogo abierto que se
 * alimenta de Stripe (`CatalogSyncService`): los demás planes se dan de alta solos al
 * sincronizar, y sólo éste tiene que existir sí o sí para que la FK
 * `FK_billing_profiles_current_plan` se pueda satisfacer desde el alta de la cuenta.
 */
export const FREE_PLAN_TYPE = 'free';

export const FREE_PLAN_NAME = 'Plan Gratuito';

/**
 * Documentos que declara el plan gratuito.
 *
 * OJO: hoy esto no concede nada. Ningún `credit_lot` se emite al crear el perfil Free —los
 * créditos gratuitos son de su propio flujo de asignación/consumo— así que este número es la
 * cifra que ese flujo leerá cuando exista, no un saldo ya otorgado.
 *
 * El valor es 1 por dos motivos: `CHK_plans_documents_included` prohíbe 0, y ante la duda
 * conviene quedarse corto —subirlo después es inofensivo, bajarlo obliga a decidir qué hacer con
 * quien ya consumió de más.
 */
export const FREE_PLAN_DOCUMENTS_INCLUDED = 1;
