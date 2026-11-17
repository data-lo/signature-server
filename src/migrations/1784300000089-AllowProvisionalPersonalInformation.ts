import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Información personal para los usuarios `PROVISIONED` (bug: el webhook aprobado de Didit fallaba
 * con "el usuario no tiene información personal registrada").
 *
 * Los usuarios provisionales de la API de integración y del aprovisionamiento de la plataforma
 * nacían con `personal_information_id = NULL`. Al aprobar Didit su identidad, guardar las imágenes
 * de la INE en `personal_information` fallaba: la verificación no pasaba a `APPROVED`, la credencial
 * no avanzaba y Didit reintentaba el webhook. Desde esta historia el provisional nace con su ficha
 * (`insertProvisionedUser`).
 *
 * 1. `personal_information.curp` admite `NULL`: un provisional no tiene CURP. Los usuarios `ACTIVE`
 *    siguen exigiéndola por el flujo de registro y por `CHK_users_active_has_credentials`, que pide
 *    `national_id`.
 * 2. **Backfill:** a cada usuario `PROVISIONED` sin ficha se le crea una con su nombre y apellido
 *    (CURP y RFC en `NULL`) y se enlaza. No toca usuarios que no sean provisionales ni a los que ya
 *    tienen ficha. Tras esto, el siguiente reintento del webhook de Didit ya puede guardar la INE.
 */
export class AllowProvisionalPersonalInformation1784300000089 implements MigrationInterface {
  name = 'AllowProvisionalPersonalInformation1784300000089';

  /**
   * Hace nulable la CURP y crea la ficha de los provisionales existentes que no la tienen.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas `users` o `personal_information`.
   *
   * @example
   * ```ts
   * await new AllowProvisionalPersonalInformation1784300000089().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "personal_information" ALTER COLUMN "curp" DROP NOT NULL`,
    );

    // El id de cada ficha se genera antes, junto al usuario, para poder enlazarlos en la misma
    // sentencia: `personal_information` no tiene ninguna columna que apunte al usuario.
    await queryRunner.query(`
      WITH "targets" AS (
        SELECT "id" AS "user_id", uuid_generate_v4() AS "personal_information_id",
               "first_name", "last_name"
        FROM "users"
        WHERE "lifecycle_status" = 'PROVISIONED' AND "personal_information_id" IS NULL
      ),
      "inserted" AS (
        INSERT INTO "personal_information" ("id", "name", "last_name", "curp", "rfc")
        SELECT "personal_information_id", "first_name", "last_name", NULL, NULL FROM "targets"
        RETURNING "id"
      )
      UPDATE "users" AS "u"
      SET "personal_information_id" = "t"."personal_information_id"
      FROM "targets" AS "t"
      JOIN "inserted" AS "i" ON "i"."id" = "t"."personal_information_id"
      WHERE "u"."id" = "t"."user_id"
    `);
  }

  /**
   * Quita las fichas sin CURP de los provisionales que todavía no guardaron imágenes de la INE y
   * vuelve a exigir la CURP.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si queda alguna ficha sin CURP (p. ej. con la INE ya guardada): revertir la
   *   borraría, y con ella la evidencia de la verificación.
   *
   * @example
   * ```ts
   * await new AllowProvisionalPersonalInformation1784300000089().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH "unlinked" AS (
        UPDATE "users" AS "u"
        SET "personal_information_id" = NULL
        FROM "personal_information" AS "p"
        WHERE "u"."personal_information_id" = "p"."id"
          AND "u"."lifecycle_status" = 'PROVISIONED'
          AND "p"."curp" IS NULL
          AND "p"."front_image_key" IS NULL
          AND "p"."back_image_key" IS NULL
        RETURNING "p"."id"
      )
      DELETE FROM "personal_information" WHERE "id" IN (SELECT "id" FROM "unlinked")
    `);

    const [{ count }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS "count" FROM "personal_information" WHERE "curp" IS NULL`,
    );
    if (count > 0) {
      throw new Error(
        'No se puede revertir AllowProvisionalPersonalInformation: hay información personal sin CURP con imágenes de la INE guardadas.',
      );
    }

    await queryRunner.query(
      `ALTER TABLE "personal_information" ALTER COLUMN "curp" SET NOT NULL`,
    );
  }
}
