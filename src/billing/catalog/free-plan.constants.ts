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
 * OJO: esto NO es lo que recibe una cuenta nueva. Lo que se le concede al dar de alta el perfil
 * Free es el lote de bienvenida —ver `FREE_WELCOME_DOCUMENT_CREDITS`, abajo—, que son otros 3
 * documentos y por una sola vez. Este número describe el plan como fila del catálogo (cuántos
 * documentos concede POR PERIODO), y el plan gratuito no tiene periodos que renovar.
 *
 * El valor es 1 por dos motivos: `CHK_plans_documents_included` prohíbe 0, y ante la duda
 * conviene quedarse corto —subirlo después es inofensivo, bajarlo obliga a decidir qué hacer con
 * quien ya consumió de más.
 */
export const FREE_PLAN_DOCUMENTS_INCLUDED = 1;

/**
 * Documentos de bienvenida del plan gratuito: **3, una sola vez**.
 *
 * Se conceden como un `credit_lot` con origen `FREE_GRANT` al dar de alta al propietario (ver
 * `BillingProfileProvisioningService`), y desde ahí cada documento nuevo gasta uno hasta
 * agotarlos.
 *
 * **No es lo mismo que `FREE_PLAN_DOCUMENTS_INCLUDED`, y por eso son dos constantes.** Aquélla
 * llena `plans.documents_included`, que describe cuántos documentos concede el plan EN CADA
 * PERIODO; el plan gratuito no tiene periodos ni renovación, así que su cifra por periodo no
 * significa nada y la que manda es ésta. Unificarlas haría que subir la bienvenida a 5 pareciera
 * prometer 5 documentos al mes.
 */
export const FREE_WELCOME_DOCUMENT_CREDITS = 3;
