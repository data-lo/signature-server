/** Origen de un registro de catálogo; Stripe nunca debe sobrescribir uno MANUAL. */
export enum CATALOG_SOURCE_ENUM {
  MANUAL = 'MANUAL',
  STRIPE = 'STRIPE',
}
