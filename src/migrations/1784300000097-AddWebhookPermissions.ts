import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permisos de la configuración de webhooks salientes desde la API de integración.
 *
 * - Recurso `WEBHOOK` con `READ` (consultar el endpoint) y `MANAGE` (crearlo, cambiarlo,
 *   desactivarlo y rotar su secreto), alcance `ANY`, igual que `STATIC_PERMISSION_CATALOG`.
 * - Se otorgan a los roles de sistema OWNER y ADMIN, como en `STATIC_ROLE_PERMISSION_MATRIX`. Se
 *   siembran aquí porque el despliegue no corre el seed; todo es idempotente (`WHERE NOT EXISTS`).
 * - Las API keys existentes no los reciben: hay que concederlos al emitir o rotar la llave.
 *
 * Las tablas de webhooks las crea `CreateOutboundWebhooks1784300000094`; esta migración no las toca.
 */
export class AddWebhookPermissions1784300000097 implements MigrationInterface {
  name = 'AddWebhookPermissions1784300000097';

  /**
   * Siembra el recurso, las acciones que falten, los permisos y su asignación a OWNER y ADMIN.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo de permisos.
   *
   * @example
   * ```ts
   * await new AddWebhookPermissions1784300000097().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
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
      SELECT 'WEBHOOK', 'WEBHOOKS SALIENTES DE LA ORGANIZACIÓN'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'WEBHOOK')
    `);

    for (const [action, description] of [
      ['READ', 'CONSULTAR UN RECURSO EXISTENTE'],
      ['MANAGE', 'ADMINISTRAR UN RECURSO Y SU CONFIGURACIÓN'],
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
      WHERE "resource"."key" = 'WEBHOOK'
        AND "action"."key" IN ('READ', 'MANAGE')
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
        AND "resource"."key" = 'WEBHOOK'
        AND "permission"."scope" = 'ANY'
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "role"."id"
            AND "existing"."permission_id" = "permission"."id"
        )
    `);
  }

  /**
   * Borra los permisos y el recurso. Primero quita esos permisos de las API keys que los tengan
   * (`api_key_permissions` es `RESTRICT`); las asignaciones a roles se van por la cascada de
   * `role_permissions`. No toca roles ni acciones: los comparten otros recursos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo. Las llaves que tenían estos
   *   permisos los pierden.
   *
   * @example
   * ```ts
   * await new AddWebhookPermissions1784300000097().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const webhookPermissions = `
      SELECT "permission"."id"
      FROM "permissions" "permission"
      JOIN "resources" "resource" ON "resource"."id" = "permission"."resource_id"
      WHERE "resource"."key" = 'WEBHOOK'
    `;
    await queryRunner.query(
      `DELETE FROM "api_key_permissions" WHERE "permission_id" IN (${webhookPermissions})`,
    );
    await queryRunner.query(
      `DELETE FROM "role_permissions" WHERE "permission_id" IN (${webhookPermissions})`,
    );
    await queryRunner.query(
      `DELETE FROM "permissions" WHERE "id" IN (${webhookPermissions})`,
    );
    await queryRunner.query(`DELETE FROM "resources" WHERE "key" = 'WEBHOOK'`);
  }
}
