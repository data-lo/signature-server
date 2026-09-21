import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Le pone rol de sistema OWNER a las cuentas PERSONAL que se quedaron sin ninguno.
 *
 * `accounts.role_id` es nullable —está reservado para invitaciones a medio completar— y hubo
 * altas de cuenta personal que lo dejaron en NULL. Una cuenta así no podía hacer nada: la
 * autorización exigía rol antes de mirar ningún permiso, así que su dueño recibía 403 hasta para
 * consultar su propio plan, y el menú le salía vacío.
 *
 * A partir de ahora esa laguna ya no decide nada: los permisos de una cuenta PERSONAL se derivan
 * del catálogo y no de su rol (ver `personal-account-permissions.ts`), y una cuenta sin rol se
 * autoriza igual que una con él. Esta migración existe igual, por dos motivos:
 *
 * - **Los caminos heredados sí siguen mirando `role_id`.** `AccountService` y
 *   `AccountMemberService` resuelven `ORGANIZATION.READ`/`UPDATE` con
 *   `RolesService.hasPermission(account.roleId, …)` —los endpoints que todavía no están anotados
 *   con `@RequirePermission` conservan su propia comprobación—, y ahí un NULL sigue siendo un
 *   403. `GET /account/:id` y `PATCH /account/:id` son de una cuenta personal tanto como de una
 *   de organización.
 * - **Deja a todas las cuentas personales iguales.** Las que nacen hoy reciben OWNER
 *   (`AccountService.createDefaultPersonalAccount`); las viejas quedaban distintas por un
 *   accidente del alta, no por una decisión.
 *
 * **Sólo toca cuentas PERSONAL con `role_id` NULL.** Una membresía de organización sin rol se
 * queda como está: ahí el NULL sí significa algo —una invitación a medio completar— y darle
 * OWNER la convertiría en propietaria de una organización ajena.
 *
 * Idempotente: una segunda pasada no encuentra filas que actualizar. Si el RBAC todavía no está
 * sembrado no hay rol OWNER del que tirar y no actualiza nada; `npm run seed:roles` lo crea y
 * esta migración se puede volver a correr.
 */
export class BackfillPersonalAccountOwnerRole1784300000063 implements MigrationInterface {
  name = 'BackfillPersonalAccountOwnerRole1784300000063';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "accounts" "a"
      SET "role_id" = "owner"."id"
      FROM "roles" "owner"
      WHERE "a"."role_id" IS NULL
        AND "a"."account_type" = 'PERSONAL'
        AND "owner"."name" = 'OWNER'
        AND "owner"."is_system_role" = true
    `);
  }

  /**
   * No revierte nada, a propósito.
   *
   * Devolver el NULL exigiría saber a qué cuentas se lo puso esta migración y a cuáles ya lo
   * tenían, y esa distinción no se guarda en ninguna parte: un `down` que pusiera NULL a todas
   * las cuentas personales con rol OWNER dejaría también sin rol a las que nacieron bien, que son
   * la inmensa mayoría. El estado que deja el `up` es el correcto en ambos sentidos —una cuenta
   * personal con su rol de propietario—, así que no hay nada que deshacer.
   */
  public async down(): Promise<void> {
    // Intencionalmente vacío: ver el docblock.
  }
}
