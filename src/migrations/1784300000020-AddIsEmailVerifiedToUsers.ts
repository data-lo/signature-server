import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia "Auth: Flujo de Pre-registro, Verificación OTP y Control por CURP": agrega el flag
 * que distingue una "pre-cuenta" (recién registrada, sin verificar su correo todavía) de una
 * cuenta activa/verificada — ver UserService.createFromSignup, que ahora branchea sobre este
 * campo en vez de solo `isActive` al detectar un CURP ya registrado.
 *
 * `national_id` ya tenía un unique constraint (que Postgres ya respalda con un índice), pero se
 * agrega aquí un índice explícito adicional para dejar constancia — la tarea técnica de la
 * historia pide asegurar explícitamente que el CURP esté indexado.
 */
export class AddIsEmailVerifiedToUsers1784300000020
  implements MigrationInterface
{
  name = 'AddIsEmailVerifiedToUsers1784300000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_email_verified" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_national_id" ON "users" ("national_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_national_id"`);

    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "is_email_verified"`,
    );
  }
}
