import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduce el rol de sistema OWNER: el que reciben las cuentas NUEVAS en lugar de ADMIN
 * (registro con cuenta personal, alta de organización y el `POST /account` genérico).
 *
 * Hasta ahora quien creaba una cuenta nacía con el rol ADMIN, el mismo que un administrador
 * puede asignarle a cualquier miembro desde la pantalla de miembros: el dueño de la cuenta y un
 * administrador nombrado por él eran indistinguibles en base. OWNER separa las dos cosas sin
 * quitarle nada a ninguno — nace con EXACTAMENTE los mismos permisos que ADMIN tenga en este
 * momento, copiados de `role_permissions`, así que ningún propietario pierde acceso y ninguna
 * ruta protegida cambia de comportamiento (los checks preguntan por permisos, no por el nombre
 * del rol; ver `RolesService.hasPermission`).
 *
 * Tres decisiones deliberadas:
 *
 * - **Los permisos se COPIAN de ADMIN en vez de escribirse a mano.** La rejilla que hoy tiene
 *   ADMIN la siembra `npm run seed:roles` y el catálogo de negocio `npm run seed:static-permissions`;
 *   enumerarla aquí la congelaría en el estado que tenía el día que se escribió esta migración.
 *   Los dos seeds siguen siendo los dueños del catálogo y ya contemplan OWNER.
 * - **ADMIN se queda.** Sigue existiendo, con sus permisos intactos y asignable a miembros: esta
 *   migración agrega un rol, no renombra el que había.
 * - **No se toca ninguna membresía existente.** Quien hoy es ADMIN —sea el dueño de su cuenta o
 *   un administrador nombrado— se queda como está: en `accounts` no hay forma de distinguir al
 *   creador de una organización de un administrador que agregó después, así que un backfill
 *   masivo convertiría en propietarios a gente que no lo es. El cambio aplica de aquí en
 *   adelante, que es lo que pide la historia.
 *
 * Idempotente: si el rol o alguna de sus asignaciones ya existe, no se duplica.
 */
export class IntroduceOwnerSystemRole1784300000055 implements MigrationInterface {
  name = 'IntroduceOwnerSystemRole1784300000055';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'OWNER', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'OWNER' AND "is_system_role" = true
      )
    `);

    /**
     * Si el RBAC todavía no está sembrado no hay ADMIN del que copiar y esto no inserta nada:
     * el rol OWNER queda creado y sin permisos, y el seed se los da al correr. Es el mismo
     * supuesto con el que convive `ReplaceAccountMemberRoleWithRoleId`.
     */
    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT "owner"."id", "admin_grant"."permission_id"
      FROM "roles" "owner"
      JOIN "roles" "admin"
        ON "admin"."name" = 'ADMIN' AND "admin"."is_system_role" = true
      JOIN "role_permissions" "admin_grant"
        ON "admin_grant"."role_id" = "admin"."id"
      WHERE "owner"."name" = 'OWNER'
        AND "owner"."is_system_role" = true
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" "existing"
          WHERE "existing"."role_id" = "owner"."id"
            AND "existing"."permission_id" = "admin_grant"."permission_id"
        )
    `);
  }

  /**
   * Devuelve a ADMIN todo lo que apunte a OWNER —membresías e invitaciones pendientes— antes de
   * borrar el rol: son FK reales, y sin esto el `DELETE` fallaría en cualquier base donde ya se
   * haya creado una cuenta. Las asignaciones de `role_permissions` se van solas (la FK es
   * `ON DELETE CASCADE`).
   *
   * Es una reversión con pérdida, como la de `ReplaceAccountMemberRoleWithRoleId`: quien nació
   * OWNER vuelve indistinguible de un ADMIN, que es justo la situación previa a esta migración.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "accounts" "a"
      SET "role_id" = "admin"."id"
      FROM "roles" "owner", "roles" "admin"
      WHERE "a"."role_id" = "owner"."id"
        AND "owner"."name" = 'OWNER' AND "owner"."is_system_role" = true
        AND "admin"."name" = 'ADMIN' AND "admin"."is_system_role" = true
    `);

    await queryRunner.query(`
      UPDATE "organization_invitations" "i"
      SET "role_id" = "admin"."id"
      FROM "roles" "owner", "roles" "admin"
      WHERE "i"."role_id" = "owner"."id"
        AND "owner"."name" = 'OWNER' AND "owner"."is_system_role" = true
        AND "admin"."name" = 'ADMIN' AND "admin"."is_system_role" = true
    `);

    await queryRunner.query(`
      DELETE FROM "roles" WHERE "name" = 'OWNER' AND "is_system_role" = true
    `);
  }
}
