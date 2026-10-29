import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retira el modelo sustituido por catalog_items/catalog_prices.
 * La migración 0040 ya copió las filas y movió checkout_orders al precio genérico.
 */
export class RemoveLegacyCatalogTables1784300000041 implements MigrationInterface {
  name = 'RemoveLegacyCatalogTables1784300000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" DROP CONSTRAINT IF EXISTS "FK_checkout_orders_plan_price"',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" DROP CONSTRAINT IF EXISTS "FK_checkout_orders_document_pack_offer"',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" DROP COLUMN IF EXISTS "plan_price_id"',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" DROP COLUMN IF EXISTS "document_pack_offer_id"',
    );

    await queryRunner.query('DROP TABLE IF EXISTS "document_pack_offers"');
    await queryRunner.query('DROP TABLE IF EXISTS "plan_prices"');
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."plan_prices_interval_enum"',
    );
  }

  /** No se puede reconstruir el modelo viejo sin perder precios históricos. */
  public async down(): Promise<void> {
    throw new Error(
      'RemoveLegacyCatalogTables no se revierte automáticamente.',
    );
  }
}
