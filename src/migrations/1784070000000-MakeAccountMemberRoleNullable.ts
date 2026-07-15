import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeAccountMemberRoleNullable1784070000000
  implements MigrationInterface
{
  name = 'MakeAccountMemberRoleNullable1784070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_members" ALTER COLUMN "role" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_members" ALTER COLUMN "role" SET NOT NULL`,
    );
  }
}
