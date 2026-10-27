import { MigrationInterface, QueryRunner } from 'typeorm';

/** Permisos del rol, como `[recurso, acción, alcance]`: los de `STATIC_ROLE_PERMISSION_MATRIX`. */
const ROLE_PERMISSIONS: [string, string, string][] = [
  ['DOCUMENT', 'CREATE', 'ANY'],
  ['DOCUMENT', 'READ', 'OWN'],
];

/**
 * Siembra el rol de sistema `INTEGRATION_DOCUMENT_CREATOR` con `DOCUMENT.CREATE` y
 * `DOCUMENT.READ_OWN` (historia "Crear documentos desde API de integración con creador
 * aprovisionado y URL pública"): el rol con el que la API de integración da de alta a un creador
 * que no era miembro de la organización.
 *
 * Es la misma asignación que declara `STATIC_ROLE_PERMISSION_MATRIX` y que deja
 * `npm run seed:static-permissions`; se hace aquí porque el despliegue no corre el seed, y sin el
 * rol `IntegrationCreatorService` respondería 500. Todo es idempotente (`WHERE NOT EXISTS`). El
 * recurso, las acciones y los permisos se insertan si faltan, con el mismo criterio que
 * `AddDirectoryPermissions`.
 */
export class AddIntegrationDocumentCreatorRole1784300000082 implements MigrationInterface {
  name = 'AddIntegrationDocumentCreatorRole1784300000082';

  /**
   * Inserta el rol, lo que falte del catálogo y sus dos asignaciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo.
   *
   * @example
   * ```ts
   * await new AddIntegrationDocumentCreatorRole1784300000082().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'INTEGRATION_DOCUMENT_CREATOR', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'INTEGRATION_DOCUMENT_CREATOR' AND "is_system_role" = true
      )
    `);

    await queryRunner.query(`
      INSERT INTO "resources" ("key", "description")
      SELECT 'DOCUMENT', 'DOCUMENTOS PARA FIRMA ELECTRÓNICA'
      WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = 'DOCUMENT')
    `);

    const actions: [string, string][] = [
      ['CREATE', 'CREAR UN RECURSO NUEVO'],
      ['READ', 'CONSULTAR UN RECURSO EXISTENTE'],
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

    for (const [resource, action, scope] of ROLE_PERMISSIONS) {
      await queryRunner.query(
        `
        INSERT INTO "permissions" ("resource_id", "action_id", "scope")
        SELECT "resource"."id", "action"."id", $3::varchar
        FROM "resources" "resource", "actions" "action"
        WHERE "resource"."key" = $1::varchar AND "action"."key" = $2::varchar
          AND NOT EXISTS (
            SELECT 1 FROM "permissions" "existing"
            WHERE "existing"."resource_id" = "resource"."id"
              AND "existing"."action_id" = "action"."id"
              AND "existing"."scope" = $3::varchar
          )
      `,
        [resource, action, scope],
      );

      await queryRunner.query(
        `
        INSERT INTO "role_permissions" ("role_id", "permission_id")
        SELECT "role"."id", "permission"."id"
        FROM "roles" "role"
        JOIN "permissions" "permission" ON true
        JOIN "resources" "resource" ON "resource"."id" = "permission"."resource_id"
        JOIN "actions" "action" ON "action"."id" = "permission"."action_id"
        WHERE "role"."name" = 'INTEGRATION_DOCUMENT_CREATOR' AND "role"."is_system_role" = true
          AND "resource"."key" = $1::varchar AND "action"."key" = $2::varchar
          AND "permission"."scope" = $3::varchar
          AND NOT EXISTS (
            SELECT 1 FROM "role_permissions" "existing"
            WHERE "existing"."role_id" = "role"."id" AND "existing"."permission_id" = "permission"."id"
          )
      `,
        [resource, action, scope],
      );
    }
  }

  /**
   * Quita el rol y sus asignaciones. No toca el catálogo: lo comparten los demás roles.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si alguna membresía tiene el rol: borrarlo la dejaría sin rol.
   *
   * @example
   * ```ts
   * await new AddIntegrationDocumentCreatorRole1784300000082().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ members }] = await queryRunner.query(`
      SELECT count(*)::int AS members FROM "accounts" "account"
      JOIN "roles" "role" ON "role"."id" = "account"."role_id"
      WHERE "role"."name" = 'INTEGRATION_DOCUMENT_CREATOR' AND "role"."is_system_role" = true
    `);
    if (members > 0) {
      throw new Error(
        `No se puede revertir AddIntegrationDocumentCreatorRole: ${members} membresías tienen el rol`,
      );
    }

    await queryRunner.query(`
      DELETE FROM "role_permissions" WHERE "role_id" IN (
        SELECT "id" FROM "roles" WHERE "name" = 'INTEGRATION_DOCUMENT_CREATOR' AND "is_system_role" = true
      )
    `);
    await queryRunner.query(
      `DELETE FROM "roles" WHERE "name" = 'INTEGRATION_DOCUMENT_CREATOR' AND "is_system_role" = true`,
    );
  }
}
