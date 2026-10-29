/**
 * Valor de `metadata.catalogType` en un producto de Stripe: a qué tabla del catálogo local
 * pertenece. Un producto de Stripe no dice por sí mismo si es un plan de suscripción o un
 * paquete de documentos —ambos son simplemente "productos" del lado del proveedor—, así que esta
 * metadata es la única forma de enrutarlo sin adivinar por nombre.
 *
 * Valores en minúscula (no `SCREAMING_SNAKE` como el resto de los enums del proyecto) a
 * propósito: esto lo escribe a mano una persona en el dashboard de Stripe, no otro sistema, y
 * minúsculas es la convención que Stripe mismo usa en su documentación de metadata.
 *
 * Un producto sin esta metadata, o con un valor que no coincide con ninguno de los dos, no
 * forma parte del catálogo local — `CatalogSyncService` lo ignora sin marcarlo como fallo.
 */
export enum CATALOG_TYPE_ENUM {
  PLAN = 'plan',
  DOCUMENT_PACK = 'document_pack',
}
