import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hace que `plan_type` sea la llave de negocio del plan y alinea sus relaciones.
 * Conserva los datos de los entornos que todavía usan las columnas `*_plan_code`.
 */
export class RefactorPlansToPlanType1784300000036
  implements MigrationInterface
{
  name = 'RefactorPlansToPlanType1784300000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE foreign_key record;
      DECLARE primary_key_name text;
      BEGIN
        FOR foreign_key IN
          SELECT conname, conrelid::regclass AS table_name
          FROM pg_constraint
          WHERE contype = 'f' AND confrelid = '"plans"'::regclass
        LOOP
          EXECUTE format(
            'ALTER TABLE %s DROP CONSTRAINT %I',
            foreign_key.table_name,
            foreign_key.conname
          );
        END LOOP;

        SELECT conname INTO primary_key_name
        FROM pg_constraint
        WHERE conrelid = '"plans"'::regclass AND contype = 'p';
        IF primary_key_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE "plans" DROP CONSTRAINT %I', primary_key_name);
        END IF;

        ALTER TABLE "plans" RENAME COLUMN "code" TO "plan_type";
        ALTER TABLE "plan_prices" RENAME COLUMN "plan_code" TO "plan_type";
        ALTER TABLE "document_pack_offers" RENAME COLUMN "eligible_plan_code" TO "eligible_plan_type";
        ALTER TABLE "billing_profiles" RENAME COLUMN "current_plan_code" TO "current_plan_type";

        ALTER TABLE "plans" RENAME COLUMN "active" TO "is_active";
        ALTER TABLE "plans" RENAME COLUMN "monthly_document_limit" TO "documents_included";
        ALTER TABLE "plans" DROP COLUMN IF EXISTS "allow_simple_signature";
        ALTER TABLE "plans" DROP COLUMN IF EXISTS "allow_advanced_signature";
        ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "CHK_plans_monthly_document_limit";
        ALTER TABLE "plans" ADD CONSTRAINT "CHK_plans_documents_included" CHECK ("documents_included" > 0);
        ALTER TABLE "plans" ADD CONSTRAINT "PK_plans" PRIMARY KEY ("plan_type");
      END $$;
    `);

    await queryRunner.query(
      'ALTER TABLE "plan_prices" ADD CONSTRAINT "FK_plan_prices_plan" FOREIGN KEY ("plan_type") REFERENCES "plans"("plan_type") ON DELETE CASCADE',
    );
    await queryRunner.query(
      'ALTER TABLE "document_pack_offers" ADD CONSTRAINT "FK_document_pack_offers_plan" FOREIGN KEY ("eligible_plan_type") REFERENCES "plans"("plan_type") ON DELETE CASCADE',
    );
    await queryRunner.query(
      'ALTER TABLE "billing_profiles" ADD CONSTRAINT "FK_billing_profiles_current_plan" FOREIGN KEY ("current_plan_type") REFERENCES "plans"("plan_type") ON DELETE SET NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "plan_prices" DROP CONSTRAINT IF EXISTS "FK_plan_prices_plan"',
    );
    await queryRunner.query(
      'ALTER TABLE "document_pack_offers" DROP CONSTRAINT IF EXISTS "FK_document_pack_offers_plan"',
    );
    await queryRunner.query(
      'ALTER TABLE "billing_profiles" DROP CONSTRAINT IF EXISTS "FK_billing_profiles_current_plan"',
    );
    await queryRunner.query('ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "PK_plans"');
    await queryRunner.query('ALTER TABLE "plans" RENAME COLUMN "plan_type" TO "code"');
    await queryRunner.query('ALTER TABLE "plan_prices" RENAME COLUMN "plan_type" TO "plan_code"');
    await queryRunner.query('ALTER TABLE "document_pack_offers" RENAME COLUMN "eligible_plan_type" TO "eligible_plan_code"');
    await queryRunner.query('ALTER TABLE "billing_profiles" RENAME COLUMN "current_plan_type" TO "current_plan_code"');
    await queryRunner.query('ALTER TABLE "plans" RENAME COLUMN "is_active" TO "active"');
    await queryRunner.query('ALTER TABLE "plans" RENAME COLUMN "documents_included" TO "monthly_document_limit"');
    await queryRunner.query('ALTER TABLE "plans" ADD COLUMN "allow_simple_signature" boolean NOT NULL DEFAULT true');
    await queryRunner.query('ALTER TABLE "plans" ADD COLUMN "allow_advanced_signature" boolean NOT NULL DEFAULT true');
    await queryRunner.query('ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "CHK_plans_documents_included"');
    await queryRunner.query('ALTER TABLE "plans" ADD CONSTRAINT "CHK_plans_monthly_document_limit" CHECK ("monthly_document_limit" > 0)');
    await queryRunner.query('ALTER TABLE "plans" ADD CONSTRAINT "PK_plans" PRIMARY KEY ("code")');
    await queryRunner.query('ALTER TABLE "plan_prices" ADD CONSTRAINT "FK_plan_prices_plan" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE CASCADE');
    await queryRunner.query('ALTER TABLE "document_pack_offers" ADD CONSTRAINT "FK_document_pack_offers_plan" FOREIGN KEY ("eligible_plan_code") REFERENCES "plans"("code") ON DELETE CASCADE');
    await queryRunner.query('ALTER TABLE "billing_profiles" ADD CONSTRAINT "FK_billing_profiles_current_plan" FOREIGN KEY ("current_plan_code") REFERENCES "plans"("code") ON DELETE SET NULL');
  }
}
