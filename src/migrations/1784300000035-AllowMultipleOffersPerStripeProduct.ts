import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `document_pack_offers.stripe_product_id` deja de ser único.
 *
 * El mismo paquete se vende a distinto importe según el plan del comprador (`eligible_plan_code`)
 * y en distintos tamaños (`documents_granted`): cada una de esas combinaciones es una fila con su
 * propio `price_...`, y todas comparten el `prod_...` del paquete. La restricción única impedía
 * exactamente eso — sólo dejaba UNA oferta por producto de Stripe—, así que
 * `CatalogSyncService.syncPriceUpserted` no podía dar de alta la segunda.
 *
 * Lo que identifica a la oferta sigue siendo el precio: `UQ_document_pack_offers_stripe_price_id`
 * se mantiene y es la llave con la que la sincronización decide entre insertar y actualizar. En
 * lugar de la única queda un índice normal, porque `product.created`/`product.updated` y
 * `product.deleted` buscan por `stripe_product_id` para actualizar o desactivar todas las ofertas
 * del paquete a la vez.
 *
 * `IF EXISTS`/`IF NOT EXISTS` por el mismo motivo que la migración del esquema de billing: las
 * bases de los entornos actuales se construyeron con `synchronize`, así que el nombre de la
 * restricción puede ser el explícito de la migración o uno autogenerado — se contemplan ambos.
 */
export class AllowMultipleOffersPerStripeProduct1784300000035 implements MigrationInterface {
  name = 'AllowMultipleOffersPerStripeProduct1784300000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const constraint of await this.uniqueConstraintsOnStripeProductId(
      queryRunner,
    )) {
      await queryRunner.query(
        `ALTER TABLE "document_pack_offers" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_document_pack_offers_stripe_product_id"
        ON "document_pack_offers" ("stripe_product_id")
    `);
  }

  /**
   * El `down` sólo puede restaurar la única si los datos actuales la admiten. Si ya hay varias
   * ofertas del mismo producto —el escenario que esta migración habilita— restaurarla fallaría;
   * se avisa y se deja el índice, que es lo único reversible sin perder filas.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_document_pack_offers_stripe_product_id"`,
    );

    const [{ duplicates }] = (await queryRunner.query(`
      SELECT COUNT(*)::int AS duplicates FROM (
        SELECT stripe_product_id FROM "document_pack_offers"
        WHERE stripe_product_id IS NOT NULL
        GROUP BY stripe_product_id HAVING COUNT(*) > 1
      ) AS repetidos
    `)) as [{ duplicates: number }];

    if (duplicates > 0) {
      throw new Error(
        `No se puede restaurar UQ_document_pack_offers_stripe_product_id: hay ${duplicates} ` +
          'producto(s) de Stripe con más de una oferta local. Consolida esas filas antes de revertir.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE "document_pack_offers"
        ADD CONSTRAINT "UQ_document_pack_offers_stripe_product_id" UNIQUE ("stripe_product_id")
    `);
  }

  /** Nombres reales de las únicas sobre esa columna: el explícito y el que pudo generar TypeORM. */
  private async uniqueConstraintsOnStripeProductId(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows = (await queryRunner.query(`
      SELECT tc.constraint_name AS name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      WHERE tc.table_name = 'document_pack_offers'
        AND tc.constraint_type = 'UNIQUE'
        AND kcu.column_name = 'stripe_product_id'
    `)) as { name: string }[];

    return rows.map((row) => row.name);
  }
}
