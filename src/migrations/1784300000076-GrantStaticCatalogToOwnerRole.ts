import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Garantiza que el rol de sistema OWNER —el que recibe quien crea una organización— tenga el
 * catálogo estático completo de permisos (bug "Asignar rol de propietario al creador de una
 * organización").
 *
 * El creador ya nacía con `role_id` de OWNER, pero ese rol podía estar vacío de lo que importa:
 *
 * - `IntroduceOwnerSystemRole1784300000055` le COPIÓ a OWNER los permisos que ADMIN tenía el día
 *   en que corrió, y `BILLING.READ`/`BILLING.MANAGE` (y el resto del catálogo de negocio) entraron
 *   después, sólo por `npm run seed:static-permissions`.
 * - El despliegue corre migraciones al arrancar (`migrationsRun`) pero nunca los seeds, así que en
 *   un entorno donde nadie volvió a correr el seed a mano OWNER se quedaba con `MEMBER.DELETE` y
 *   los cuatro de DIRECTORY (que sí siembra `AddDirectoryPermissions1784300000073`). El creador no
 *   podía ver los planes de su organización —Planes y Suscripciones exigen `BILLING.READ`— ni
 *   administrarla.
 *
 * Se hace lo mismo que la 073 hizo con el directorio, ahora para todo el catálogo de OWNER: los
 * recursos, acciones y permisos de `STATIC_PERMISSION_CATALOG` se insertan si faltan y se le
 * otorgan a OWNER, que según `STATIC_ROLE_PERMISSION_MATRIX` recibe el catálogo entero. Las
 * definiciones van escritas aquí y no importadas del catálogo para que la migración no cambie de
 * significado cuando el catálogo crezca; las descripciones son las mismas, así que el seed no
 * encuentra nada que corregir.
 *
 * **Sólo se toca OWNER.** ADMIN, MEMBER y los roles personalizados se quedan como estén: subirles
 * permisos cambiaría lo que pueden hacer miembros existentes de otras organizaciones, y eso sigue
 * siendo decisión del seed o del propietario de cada organización. Tampoco se cambia el rol de
 * ninguna membresía.
 *
 * Idempotente (`WHERE NOT EXISTS` en cada inserción): en una base ya sembrada no hace nada.
 */

/** Recursos del catálogo estático, con la descripción de `STATIC_CATALOG_RESOURCES`. */
const CATALOG_RESOURCES: [string, string][] = [
  ['ORGANIZATION', 'CUENTAS DE TIPO ORGANIZACIÓN'],
  ['BILLING', 'PLAN, PAGOS Y SUSCRIPCIÓN DE LA ORGANIZACIÓN'],
  ['MEMBER', 'MIEMBROS DE UNA ORGANIZACIÓN'],
  ['ROLE', 'ROLES Y PERMISOS DE LA ORGANIZACIÓN'],
  ['DOCUMENT', 'DOCUMENTOS PARA FIRMA ELECTRÓNICA'],
  ['DIRECTORY', 'DIRECTORIO DE CONTACTOS DE LA CUENTA'],
];

/** Acciones del catálogo estático, con la descripción de `STATIC_CATALOG_ACTIONS`. */
const CATALOG_ACTIONS: [string, string][] = [
  ['CREATE', 'CREAR UN RECURSO NUEVO'],
  ['READ', 'CONSULTAR UN RECURSO EXISTENTE'],
  ['UPDATE', 'ACTUALIZAR UN RECURSO EXISTENTE'],
  ['MANAGE', 'ADMINISTRAR UN RECURSO Y SU CONFIGURACIÓN'],
  ['INVITE', 'INVITAR A UN USUARIO'],
  ['REMOVE', 'REVOCAR O ELIMINAR UNA MEMBRESÍA'],
  ['SEND_SIGNATURE_REQUEST', 'ENVIAR UNA SOLICITUD DE FIRMA'],
  ['SIGN', 'FIRMAR UN DOCUMENTO'],
  ['APPROVE', 'APROBAR O AUTORIZAR UN RECURSO'],
  ['CANCEL', 'SOLICITAR O CONFIRMAR UNA CANCELACIÓN'],
  ['DELETE', 'ELIMINAR O ARCHIVAR UN RECURSO EXISTENTE'],
];

/** Los 21 permisos de `STATIC_PERMISSION_CATALOG`, como `[recurso, acción, alcance]`. */
const CATALOG_PERMISSIONS: [string, string, string][] = [
  ['ORGANIZATION', 'READ', 'ANY'],
  ['ORGANIZATION', 'UPDATE', 'ANY'],
  ['BILLING', 'READ', 'ANY'],
  ['BILLING', 'MANAGE', 'ANY'],
  ['MEMBER', 'READ', 'ANY'],
  ['MEMBER', 'INVITE', 'ANY'],
  ['MEMBER', 'UPDATE', 'ANY'],
  ['MEMBER', 'REMOVE', 'ANY'],
  ['ROLE', 'READ', 'ANY'],
  ['ROLE', 'MANAGE', 'ANY'],
  ['DOCUMENT', 'CREATE', 'ANY'],
  ['DOCUMENT', 'READ', 'OWN'],
  ['DOCUMENT', 'READ', 'ORGANIZATION'],
  ['DOCUMENT', 'SEND_SIGNATURE_REQUEST', 'ANY'],
  ['DOCUMENT', 'SIGN', 'SELF'],
  ['DOCUMENT', 'APPROVE', 'ANY'],
  ['DOCUMENT', 'CANCEL', 'ANY'],
  ['DIRECTORY', 'READ', 'ANY'],
  ['DIRECTORY', 'CREATE', 'ANY'],
  ['DIRECTORY', 'UPDATE', 'ANY'],
  ['DIRECTORY', 'DELETE', 'ANY'],
];

export class GrantStaticCatalogToOwnerRole1784300000076 implements MigrationInterface {
  name = 'GrantStaticCatalogToOwnerRole1784300000076';

  /**
   * Inserta el rol OWNER, los recursos, acciones y permisos del catálogo que falten, y le otorga
   * a OWNER los 21 permisos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen las tablas del catálogo (`roles`, `resources`,
   *   `actions`, `permissions`, `role_permissions`).
   *
   * @example
   * ```ts
   * await new GrantStaticCatalogToOwnerRole1784300000076().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'OWNER', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'OWNER' AND "is_system_role" = true
      )
    `);

    for (const [key, description] of CATALOG_RESOURCES) {
      await queryRunner.query(
        `
        INSERT INTO "resources" ("key", "description")
        SELECT $1::varchar, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "resources" WHERE "key" = $1::varchar)
      `,
        [key, description],
      );
    }

    for (const [key, description] of CATALOG_ACTIONS) {
      await queryRunner.query(
        `
        INSERT INTO "actions" ("key", "description")
        SELECT $1::varchar, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "actions" WHERE "key" = $1::varchar)
      `,
        [key, description],
      );
    }

    for (const [resourceKey, actionKey, scope] of CATALOG_PERMISSIONS) {
      await queryRunner.query(
        `
        INSERT INTO "permissions" ("resource_id", "action_id", "scope")
        SELECT "resource"."id", "action"."id", $3::varchar
        FROM "resources" "resource", "actions" "action"
        WHERE "resource"."key" = $1::varchar
          AND "action"."key" = $2::varchar
          AND NOT EXISTS (
            SELECT 1 FROM "permissions" "existing"
            WHERE "existing"."resource_id" = "resource"."id"
              AND "existing"."action_id" = "action"."id"
              AND "existing"."scope" = $3::varchar
          )
      `,
        [resourceKey, actionKey, scope],
      );

      await queryRunner.query(
        `
        INSERT INTO "role_permissions" ("role_id", "permission_id")
        SELECT "owner"."id", "permission"."id"
        FROM "roles" "owner"
        JOIN "permissions" "permission" ON "permission"."scope" = $3::varchar
        JOIN "resources" "resource"
          ON "resource"."id" = "permission"."resource_id" AND "resource"."key" = $1::varchar
        JOIN "actions" "action"
          ON "action"."id" = "permission"."action_id" AND "action"."key" = $2::varchar
        WHERE "owner"."name" = 'OWNER'
          AND "owner"."is_system_role" = true
          AND NOT EXISTS (
            SELECT 1 FROM "role_permissions" "existing"
            WHERE "existing"."role_id" = "owner"."id"
              AND "existing"."permission_id" = "permission"."id"
          )
      `,
        [resourceKey, actionKey, scope],
      );
    }
  }

  /**
   * No deshace nada, a propósito.
   *
   * Esta migración sólo completa lo que el seed ya declara para OWNER, y en una base sembrada no
   * inserta ninguna fila: no hay forma de distinguir lo que puso ella de lo que puso el seed.
   * Borrar los permisos o sus asignaciones al revertir dejaría a los propietarios sin acceso a los
   * planes de su organización, que es justo el bug que corrige.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new GrantStaticCatalogToOwnerRole1784300000076().down();
   * ```
   */
  public async down(): Promise<void> {
    return;
  }
}
