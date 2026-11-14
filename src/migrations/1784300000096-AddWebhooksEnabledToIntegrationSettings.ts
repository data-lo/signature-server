import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Envío de webhooks configurable desde la API de integración, y sus permisos.
 *
 * - Agrega `webhooks_enabled` a `integration_settings`, la tabla que crea
 *   `CreateIntegrationSettings1784300000095` (una fila por organización con su `status`).
 * - `webhooks_enabled` nace en `false` para todas las filas existentes: **no hay backfill a
 *   `true`**, ninguna organización empieza a recibir webhooks por esta migración. Sin fila, la
 *   organización también se comporta como `false`.
 * - Recurso `INTEGRATION_SETTINGS` con `READ` y `UPDATE` (alcance `ANY`), otorgados a los roles de
 *   sistema OWNER y ADMIN, igual que `STATIC_ROLE_PERMISSION_MATRIX`. Se siembran aquí porque el
 *   despliegue no corre el seed; todo es idempotente (`WHERE NOT EXISTS`). Las API keys no los
 *   reciben solas: hay que concederlos al emitir o rotar la llave.
 */
export class AddWebhooksEnabledToIntegrationSettings1784300000096 implements MigrationInterface {
  name = 'AddWebhooksEnabledToIntegrationSettings1784300000096';

  /**
   * Agrega la columna y siembra los permisos con sus asignaciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `integration_settings` (falta la 095) o las tablas del
   *   catálogo, o si la columna ya existe.
   *
   * @example
   * ```ts
   * await new AddWebhooksEnabledToIntegrationSettings1784300000096().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "integration_settings" ADD "webhooks_enabled" boolean NOT NULL DEFAULT false`,
    );

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
   * Quita la columna, los permisos y el recurso; la tabla y su `status` (095) se conservan. Primero
   * quita esos permisos de las API keys que los tengan (`api_key_permissions` es `RESTRICT`); las
   * asignaciones a roles se van por la cascada de `role_permissions`. No toca roles ni acciones:
   * los comparten otros recursos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la columna no existe. Las llaves que tenían estos permisos los
   *   pierden, y se pierde la preferencia de webhooks de cada organización.
   *
   * @example
   * ```ts
   * await new AddWebhooksEnabledToIntegrationSettings1784300000096().down(queryRunner);
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
    await queryRunner.query(
      `ALTER TABLE "integration_settings" DROP COLUMN "webhooks_enabled"`,
    );
  }
}
