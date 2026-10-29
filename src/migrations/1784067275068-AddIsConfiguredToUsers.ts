import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsConfiguredToUsers1784067275068 implements MigrationInterface {
  name = 'AddIsConfiguredToUsers1784067275068';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_configured" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_configured"`);
  }
}
