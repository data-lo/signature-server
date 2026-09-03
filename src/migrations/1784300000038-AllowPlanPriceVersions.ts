import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permite conservar varias versiones locales de un mismo `stripe_price_id`.
 * Cada nueva versión conserva el historial de órdenes que apuntan al `plan_price_id` anterior.
 */
export class AllowPlanPriceVersions1784300000038
  implements MigrationInterface
{
  name = 'AllowPlanPriceVersions1784300000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El nombre puede variar: la tabla pudo haber sido creada previamente por `synchronize`.
    // Se elimina cualquier UNIQUE que use stripe_price_id, no sólo el de la migración inicial.
    await queryRunner.query(`
      DO $$
      DECLARE constraint_name text;
      BEGIN
        FOR constraint_name IN
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          INNER JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
          WHERE tc.table_schema = 'public'
            AND tc.table_name = 'plan_prices'
            AND tc.constraint_type = 'UNIQUE'
            AND kcu.column_name = 'stripe_price_id'
        LOOP
          EXECUTE format('ALTER TABLE "plan_prices" DROP CONSTRAINT %I', constraint_name);
        END LOOP;
      END $$;
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_plan_prices_stripe_price_id" ON "plan_prices" ("stripe_price_id")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_plan_prices_stripe_price_id"',
    );
    await queryRunner.query(
      'ALTER TABLE "plan_prices" ADD CONSTRAINT "UQ_plan_prices_stripe_price_id" UNIQUE ("stripe_price_id")',
    );
  }
}
