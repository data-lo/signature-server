import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra el permiso `API_KEY.MANAGE` y se lo otorga a los roles de sistema OWNER y ADMIN
 * (historia "Implementar endpoints internos de administración de API Keys por organización").
 *
 * Es la misma asignación que declara `STATIC_ROLE_PERMISSION_MATRIX`, y la misma que deja
 * `npm run seed:static-permissions`; se hace también aquí porque el despliegue no corre el seed, y
 * sin la fila los endpoints de `/organizations/:organizationId/api-keys` responderían 403 a todos.
 * Todo es idempotente (`WHERE NOT EXISTS`), así que da igual cuál de los dos llegue primero.
 *
 * MEMBER no lo recibe. Las cuentas personales no pasan por `role_permissions` y el permiso es
 * `organizationOnly`, así que tampoco lo ejercen.
 *
 * Los roles OWNER y ADMIN y la acción `MANAGE` se insertan si faltan, con el mismo criterio que
 * `AddDirectoryPermissions`: esta migración no puede asumir que las que los introducen ya corrieron.
 */
export class AddApiKeyManagePermission1784300000078 implements MigrationInterface {
  name = 'AddApiKeyManagePermission1784300000078';

  /**
   * Inserta el recurso, la acción si falta, el permiso y sus dos asignaciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo (`roles`, `resources`,
   *   `actions`, `permissions`, `role_permissions`).
   *
   * @example
   * ```ts
   * await new AddApiKeyManagePermission1784300000078().up(queryRunner);
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
      SELECT 'API_KEY', 'API KEYS DE INTEGRACIÓN DE LA ORGANIZACIÓN'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'API_KEY')
    `);

    await queryRunner.query(`
      INSERT INTO "actions" ("key", "description")
      SELECT 'MANAGE', 'ADMINISTRAR UN RECURSO Y SU CONFIGURACIÓN'
      WHERE NOT EXISTS (SELECT 1 FROM "actions" WHERE "key" = 'MANAGE')
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("resource_id", "action_id", "scope")
      SELECT "resource"."id", "action"."id", 'ANY'
      FROM "resources" "resource", "actions" "action"
      WHERE "resource"."key" = 'API_KEY'
        AND "action"."key" = 'MANAGE'
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
        AND "resource"."key" = 'API_KEY'
        AND "permission"."scope" = 'ANY'
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "role"."id"
            AND "existing"."permission_id" = "permission"."id"
        )
    `);
  }

  /**
   * Borra el permiso y el recurso; las asignaciones se van solas (la FK de `role_permissions` es
   * `ON DELETE CASCADE`).
   *
   * No toca roles ni la acción `MANAGE`: los comparten otros recursos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo. Los roles custom que tengan
   *   asignado `API_KEY.MANAGE` lo pierden por la misma cascada.
   *
   * @example
   * ```ts
   * await new AddApiKeyManagePermission1784300000078().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "permissions" "permission"
      USING "resources" "resource"
      WHERE "resource"."id" = "permission"."resource_id"
        AND "resource"."key" = 'API_KEY'
    `);
    await queryRunner.query(`DELETE FROM "resources" WHERE "key" = 'API_KEY'`);
  }
}
