import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Usuarios aprovisionados por la API de integración (historia "Crear documentos desde API de
 * integración con creador aprovisionado y URL pública").
 *
 * 1. `users.lifecycle_status` (`PROVISIONED` | `ACTIVE`, por omisión `ACTIVE`): todo usuario que
 *    ya existía se registró él mismo, así que nace `ACTIVE`.
 * 2. `users.password`, `users.national_id` y `users.personal_information_id` admiten `NULL`, pero
 *    `CHK_users_active_has_credentials` sólo lo permite mientras el usuario esté `PROVISIONED`:
 *    un usuario `ACTIVE` sigue teniendo los tres.
 * 3. `accounts.password` admite `NULL`: es la copia sincronizada de `users.password`, y las cuentas
 *    de un usuario aprovisionado no tienen contraseña. El login la rechaza (`LoginUseCase`).
 *
 * `national_id` conserva su índice único: Postgres admite varios `NULL` en un `UNIQUE`.
 */
export class AddLifecycleStatusToUsers1784300000080 implements MigrationInterface {
  name = 'AddLifecycleStatusToUsers1784300000080';

  /**
   * Agrega el estado de ciclo de vida y relaja las columnas de credenciales.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `users` o `accounts`.
   *
   * @example
   * ```ts
   * await new AddLifecycleStatusToUsers1784300000080().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_lifecycle_status_enum" AS ENUM('PROVISIONED', 'ACTIVE')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "lifecycle_status" "public"."users_lifecycle_status_enum" NOT NULL DEFAULT 'ACTIVE'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "national_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "personal_information_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_active_has_credentials" CHECK ("lifecycle_status" = 'PROVISIONED' OR ("password" IS NOT NULL AND "national_id" IS NOT NULL AND "personal_information_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "password" DROP NOT NULL`,
    );
  }

  /**
   * Vuelve a exigir las credenciales y quita el estado.
   *
   * No borra usuarios: si hay alguno `PROVISIONED`, o cuentas sin contraseña, se niega a revertir
   * en vez de perder a quienes ya tienen documentos creados a su nombre.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si quedan usuarios `PROVISIONED` o cuentas sin contraseña.
   *
   * @example
   * ```ts
   * await new AddLifecycleStatusToUsers1784300000080().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ provisioned }] = await queryRunner.query(
      `SELECT count(*)::int AS provisioned FROM "users" WHERE "lifecycle_status" = 'PROVISIONED' OR "password" IS NULL`,
    );
    const [{ withoutPassword }] = await queryRunner.query(
      `SELECT count(*)::int AS "withoutPassword" FROM "accounts" WHERE "password" IS NULL`,
    );
    if (provisioned > 0 || withoutPassword > 0) {
      throw new Error(
        `No se puede revertir AddLifecycleStatusToUsers: hay ${provisioned} usuarios aprovisionados y ${withoutPassword} cuentas sin contraseña`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "password" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "CHK_users_active_has_credentials"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "personal_information_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "national_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "lifecycle_status"`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_lifecycle_status_enum"`);
  }
}
