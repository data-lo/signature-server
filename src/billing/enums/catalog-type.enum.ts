/**
 * Valor de `metadata.catalogType` en un producto de Stripe: a qué tabla del catálogo local
 * pertenece. Un producto no dice por sí mismo si es plan o paquete —del lado del proveedor ambos son
 * "productos"—, así que esta metadata es la única forma de enrutarlo sin adivinar por nombre.
 *
 * Usa minúsculas y no `SCREAMING_SNAKE` como el resto de los enums: esto lo escribe a mano una
 * persona en el dashboard, y minúsculas es la convención de la propia documentación de Stripe.
 *
 * Un producto sin esta metadata, o con un valor que no coincide, queda fuera del catálogo local y
 * `CatalogSyncService` lo ignora sin marcarlo como fallo.
 */
export enum CATALOG_TYPE_ENUM {
  PLAN = 'plan',
  DOCUMENT_PACK = 'document_pack',
}
