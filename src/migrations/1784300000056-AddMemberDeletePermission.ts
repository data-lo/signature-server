import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega el permiso `MEMBER.DELETE` —dar de baja a un miembro de la organización— al catálogo de
 * permisos estáticos, y se lo otorga SÓLO al rol de sistema OWNER.
 *
 * Es la primera capacidad del catálogo que no comparten OWNER y ADMIN: un administrador sigue
 * invitando, leyendo toda la organización, enviando solicitudes y aprobando, pero eliminar a
 * alguien queda del lado de quien es dueño de la cuenta (ver `STATIC_ROLE_PERMISSION_MATRIX`).
 *
 * El rol OWNER se inserta aquí mismo si falta, con el mismo `WHERE NOT EXISTS` con el que
 * `ReplaceAccountMemberRoleWithRoleId` insertó ADMIN y MEMBER: esta migración no puede asumir
 * que la que lo introduce ya se aplicó, y al ser idempotente da igual cuál de las dos corra
 * primero. Lo mismo con el recurso `MEMBER` y la acción `DELETE`, que hoy siembran
 * `npm run seed:static-permissions` y `npm run seed:roles`: si ya están, se reutilizan tal cual.
 *
 * **Esto es catálogo, no enforcement.** Ninguna ruta pregunta todavía por `MEMBER.DELETE`:
 * `RolesService.hasPermission` sólo se consulta hoy para el recurso ORGANIZATION, así que quien
 * puede dar de baja a un miembro sigue siendo quien puede administrar la organización. Conectar
 * el permiso con `RevokeAccountAccessUseCase` es el ticket de RBAC efectivo — hacerlo aquí
 * cambiaría en silencio quién puede eliminar miembros hoy.
 */
export class AddMemberDeletePermission1784300000056 implements MigrationInterface {
  name = 'AddMemberDeletePermission1784300000056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'OWNER', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'OWNER' AND "is_system_role" = true
      )
    `);

    await queryRunner.query(`
      INSERT INTO "resources" ("key", "description")
      SELECT 'MEMBER', 'Miembros de una organización'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'MEMBER')
    `);

    await queryRunner.query(`
      INSERT INTO "actions" ("key", "description")
      SELECT 'DELETE', 'Eliminar un recurso existente'
      WHERE NOT EXISTS (SELECT 1 FROM "actions" WHERE "key" = 'DELETE')
    `);

    /**
     * Alcance `ANY`: el permiso no distingue a qué miembros alcanza. La protección del último
     * administrador vive en la aplicación (`AccountMemberService.assertNotLastAdmin`) y no es
     * algo que el catálogo pueda expresar con un scope.
     */
    await queryRunner.query(`
      INSERT INTO "permissions" ("resource_id", "action_id", "scope")
      SELECT "resource"."id", "action"."id", 'ANY'
      FROM "resources" "resource", "actions" "action"
      WHERE "resource"."key" = 'MEMBER'
        AND "action"."key" = 'DELETE'
        AND NOT EXISTS (
          SELECT 1 FROM "permissions" "existing"
          WHERE "existing"."resource_id" = "resource"."id"
            AND "existing"."action_id" = "action"."id"
            AND "existing"."scope" = 'ANY'
        )
    `);

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT "owner"."id", "permission"."id"
      FROM "roles" "owner"
      JOIN "permissions" "permission" ON true
      JOIN "resources" "resource" ON "resource"."id" = "permission"."resource_id"
      JOIN "actions" "action" ON "action"."id" = "permission"."action_id"
      WHERE "owner"."name" = 'OWNER'
        AND "owner"."is_system_role" = true
        AND "resource"."key" = 'MEMBER'
        AND "action"."key" = 'DELETE'
        AND "permission"."scope" = 'ANY'
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "owner"."id"
            AND "existing"."permission_id" = "permission"."id"
        )
    `);
  }

  /**
   * Borra el permiso que agregó; sus asignaciones se van solas (la FK de `role_permissions` es
   * `ON DELETE CASCADE`).
   *
   * No toca el rol OWNER ni el recurso/acción que pudo haber insertado: pueden venir de otra
   * migración o del seed, y hay membresías que apuntan al rol. Revertir de más aquí rompería
   * cosas que esta migración no creó.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "permissions" "permission"
      USING "resources" "resource", "actions" "action"
      WHERE "resource"."id" = "permission"."resource_id"
        AND "action"."id" = "permission"."action_id"
        AND "resource"."key" = 'MEMBER'
        AND "action"."key" = 'DELETE'
        AND "permission"."scope" = 'ANY'
    `);
  }
}
