import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra los permisos `DIRECTORY.READ`, `DIRECTORY.CREATE`, `DIRECTORY.UPDATE` y
 * `DIRECTORY.DELETE` y se los otorga a los roles de sistema OWNER y ADMIN (historia "Implementar
 * los endpoints NestJS necesarios para consultar y administrar los contactos del directorio").
 *
 * Es la misma asignación que declara `STATIC_ROLE_PERMISSION_MATRIX`, y la misma que deja
 * `npm run seed:static-permissions`; se hace también aquí para que los endpoints del directorio
 * funcionen en cuanto se despliegan, sin depender de que alguien corra el seed. Todo es
 * idempotente (`WHERE NOT EXISTS`), así que da igual cuál de los dos llegue primero.
 *
 * MEMBER no recibe ninguno: conserva sus tres capacidades de fábrica (crear, ver lo suyo y firmar).
 * Las cuentas personales no pasan por `role_permissions`; sus permisos de directorio salen del
 * catálogo en código (`organizationOnly: false`).
 *
 * Los roles OWNER y ADMIN se insertan si faltan, con el mismo criterio que
 * `AddMemberDeletePermission`: esta migración no puede asumir que la que los introduce ya corrió.
 */
export class AddDirectoryPermissions1784300000073 implements MigrationInterface {
  name = 'AddDirectoryPermissions1784300000073';

  /**
   * Inserta el recurso, las acciones que falten, los cuatro permisos y sus asignaciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo (`roles`, `resources`,
   *   `actions`, `permissions`, `role_permissions`).
   *
   * @example
   * ```ts
   * await new AddDirectoryPermissions1784300000073().up(queryRunner);
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
      SELECT 'DIRECTORY', 'DIRECTORIO DE CONTACTOS DE LA CUENTA'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'DIRECTORY')
    `);

    const actions: [string, string][] = [
      ['READ', 'CONSULTAR UN RECURSO EXISTENTE'],
      ['CREATE', 'CREAR UN RECURSO NUEVO'],
      ['UPDATE', 'ACTUALIZAR UN RECURSO EXISTENTE'],
      ['DELETE', 'ELIMINAR O ARCHIVAR UN RECURSO EXISTENTE'],
    ];
    for (const [key, description] of actions) {
      await queryRunner.query(
        `
        INSERT INTO "actions" ("key", "description")
        SELECT $1::varchar, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "actions" WHERE "key" = $1::varchar)
      `,
        [key, description],
      );
    }

    await queryRunner.query(`
      INSERT INTO "permissions" ("resource_id", "action_id", "scope")
      SELECT "resource"."id", "action"."id", 'ANY'
      FROM "resources" "resource", "actions" "action"
      WHERE "resource"."key" = 'DIRECTORY'
        AND "action"."key" IN ('READ', 'CREATE', 'UPDATE', 'DELETE')
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
        AND "resource"."key" = 'DIRECTORY'
        AND "permission"."scope" = 'ANY'
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "role"."id"
            AND "existing"."permission_id" = "permission"."id"
        )
    `);
  }

  /**
   * Borra los cuatro permisos y el recurso; las asignaciones se van solas (la FK de
   * `role_permissions` es `ON DELETE CASCADE`).
   *
   * No toca roles ni acciones: las comparten otros recursos, y hay membresías que apuntan a los
   * roles.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo. Los roles custom que tengan
   *   asignado algún permiso de directorio lo pierden por la misma cascada.
   *
   * @example
   * ```ts
   * await new AddDirectoryPermissions1784300000073().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "permissions" "permission"
      USING "resources" "resource"
      WHERE "resource"."id" = "permission"."resource_id"
        AND "resource"."key" = 'DIRECTORY'
    `);
    await queryRunner.query(
      `DELETE FROM "resources" WHERE "key" = 'DIRECTORY'`,
    );
  }
}
