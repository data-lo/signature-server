import { MigrationInterface, QueryRunner } from 'typeorm';

/** Distingue planes creados manualmente de los dados de alta por un webhook de Stripe. */
export class AddPlanCreationSource1784300000037
  implements MigrationInterface
{
  name = 'AddPlanCreationSource1784300000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'plans_creation_source_enum'
        ) THEN
          CREATE TYPE "public"."plans_creation_source_enum" AS ENUM ('MANUAL', 'STRIPE');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD COLUMN IF NOT EXISTS "creation_source" "public"."plans_creation_source_enum"
        NOT NULL DEFAULT 'MANUAL'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "plans" DROP COLUMN IF EXISTS "creation_source"',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."plans_creation_source_enum"',
    );
  }
}
