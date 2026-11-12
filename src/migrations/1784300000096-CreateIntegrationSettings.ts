import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuración de la API de integración por organización y sus permisos.
 *
 * - `integration_settings`: una fila como máximo por organización
 *   (`UQ_integration_settings_organization_id`), que se borra con ella (`ON DELETE CASCADE`). Es una
 *   restricción `UNIQUE` —Postgres la respalda con un índice único— y no un `CREATE UNIQUE INDEX`
 *   suelto, porque la relación `OneToOne` de la entidad exige una restricción.
 * - `webhooks_enabled` nace en `false` y **no hay backfill**: ninguna organización existente recibe
 *   webhooks por esta migración. Sin fila, la organización se comporta como `false`.
 * - Recurso `INTEGRATION_SETTINGS` con `READ` y `UPDATE` (alcance `ANY`), otorgados a los roles de
 *   sistema OWNER y ADMIN, igual que `STATIC_ROLE_PERMISSION_MATRIX`. Se siembran aquí porque el
 *   despliegue no corre el seed; todo es idempotente (`WHERE NOT EXISTS`). Las API keys no los
 *   reciben solas: hay que concederlos al emitir o rotar la llave.
 */
export class CreateIntegrationSettings1784300000096 implements MigrationInterface {
  name = 'CreateIntegrationSettings1784300000096';

  /**
   * Crea la tabla y siembra los permisos con sus asignaciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `organizations` o las tablas del catálogo, o si la
   *   tabla ya existe.
   *
   * @example
   * ```ts
   * await new CreateIntegrationSettings1784300000096().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "integration_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "webhooks_enabled" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_integration_settings_organization_id" UNIQUE ("organization_id"),
        CONSTRAINT "FK_integration_settings_organization_id" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    for (const roleName of ['OWNER', 'ADMIN']) {
      await queryRunner.query(
        `
        INSERT INTO "roles" ("name", "is_system_role", "organization_id")
        SELECT $1::varchar, true, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM "roles" WHERE "name" = $1::varchar AND "is_system_role" = true
        )
      `,
        [roleName],
      );
    }

    await queryRunner.query(`
      INSERT INTO "resources" ("key", "description")
      SELECT 'INTEGRATION_SETTINGS', 'CONFIGURACIÓN DE LA INTEGRACIÓN DE LA ORGANIZACIÓN'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'INTEGRATION_SETTINGS')
    `);

    for (const [action, description] of [
      ['READ', 'CONSULTAR UN RECURSO EXISTENTE'],
      ['UPDATE', 'ACTUALIZAR UN RECURSO EXISTENTE'],
    ]) {
      await queryRunner.query(
        `
        INSERT INTO "actions" ("key", "description")
        SELECT $1::varchar, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "actions" WHERE "key" = $1::varchar)
      `,
        [action, description],
      );
    }

    await queryRunner.query(`
      INSERT INTO "permissions" ("resource_id", "action_id", "scope")
      SELECT "resource"."id", "action"."id", 'ANY'
      FROM "resources" "resource", "actions" "action"
      WHERE "resource"."key" = 'INTEGRATION_SETTINGS'
        AND "action"."key" IN ('READ', 'UPDATE')
        AND NOT EXISTS (
          SELECT 1 FROM "permissions" "existing"
          WHERE "existing"."resource_id" = "resource"."id"
            AND "existing"."action_id" = "action"."id"
            AND "existing"."scope" = 'ANY'
        )
    `);

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT "role"."id", "permission"."id"
      FROM "roles" "role"
      JOIN "permissions" "permission" ON true
      JOIN "resources" "resource" ON "resource"."id" = "permission"."resource_id"
      WHERE "role"."name" IN ('OWNER', 'ADMIN')
        AND "role"."is_system_role" = true
        AND "resource"."key" = 'INTEGRATION_SETTINGS'
        AND "permission"."scope" = 'ANY'
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "role"."id"
            AND "existing"."permission_id" = "permission"."id"
        )
    `);
  }

  /**
   * Borra la tabla, los permisos y el recurso. Primero quita esos permisos de las API keys que los
   * tengan (`api_key_permissions` es `RESTRICT`); las asignaciones a roles se van por la cascada de
   * `role_permissions`. No toca roles ni acciones: los comparten otros recursos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no existe. Las llaves que tenían estos permisos los
   *   pierden.
   *
   * @example
   * ```ts
   * await new CreateIntegrationSettings1784300000096().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "api_key_permissions" "assigned"
      USING "permissions" "permission", "resources" "resource"
      WHERE "permission"."id" = "assigned"."permission_id"
        AND "resource"."id" = "permission"."resource_id"
        AND "resource"."key" = 'INTEGRATION_SETTINGS'
    `);
    await queryRunner.query(`
      DELETE FROM "permissions" "permission"
      USING "resources" "resource"
      WHERE "resource"."id" = "permission"."resource_id"
        AND "resource"."key" = 'INTEGRATION_SETTINGS'
    `);
    await queryRunner.query(
      `DELETE FROM "resources" WHERE "key" = 'INTEGRATION_SETTINGS'`,
    );
    await queryRunner.query(`DROP TABLE "integration_settings"`);
  }
}
