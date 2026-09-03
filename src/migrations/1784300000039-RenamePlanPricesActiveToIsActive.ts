import { MigrationInterface, QueryRunner } from 'typeorm';

/** Alinea el estado de `plan_prices` con la convención `is_active` del catálogo. */
export class RenamePlanPricesActiveToIsActive1784300000039
  implements MigrationInterface
{
  name = 'RenamePlanPricesActiveToIsActive1784300000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "plan_prices" RENAME COLUMN "active" TO "is_active"',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "plan_prices" RENAME COLUMN "is_active" TO "active"',
    );
  }
}
