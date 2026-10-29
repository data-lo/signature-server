import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Estandariza `collaborators_status_enum` a mayúsculas y agrega `NOTIFIED` (historia "Actualizar
 * estatus de watchers a NOTIFIED tras el envío de correo y estandarizar estatus en mayúsculas").
 *
 * `RENAME VALUE` en vez de `ADD VALUE` + `UPDATE`: los enums de Postgres se guardan por OID, no
 * por texto, así que renombrar una etiqueta hace que CUALQUIER fila existente se lea con el
 * nombre nuevo de inmediato — no hace falta ningún `UPDATE` de datos aparte.
 *
 * Sin `transaction = false` (a diferencia de `1784300000042-AddFreeBillingProfileStatus`, que sí
 * lo necesita): esa restricción de Postgres (error 55P04) sólo aplica cuando se ESCRIBE una fila
 * con el valor nuevo en la misma transacción que lo declaró (ver también
 * `1784300000040-AddCollaboratorSignedToEventType`, que agrega un valor transaccionalmente sin
 * problema por la misma razón). Esta migración nunca escribe `'NOTIFIED'` en ninguna fila, sólo
 * declara la etiqueta — corre transaccional para que un fallo a medias revierta las cinco
 * sentencias juntas en vez de dejar el enum a medio renombrar.
 *
 * El `ALTER TABLE ... SET DEFAULT` es necesario aparte: `RENAME VALUE` no retoca el default de la
 * columna, que se queda guardado como el texto literal `'pending'` si no se actualiza a mano.
 */
export class UppercaseCollaboratorStatusAddNotified1784300000053 implements MigrationInterface {
  name = 'UppercaseCollaboratorStatusAddNotified1784300000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'pending' TO 'PENDING'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'signed' TO 'SIGNED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'rejected' TO 'REJECTED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" ADD VALUE IF NOT EXISTS 'NOTIFIED'`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
  }

  /**
   * No se quita `NOTIFIED`: Postgres no sabe eliminar un valor de enum sin recrear el tipo
   * completo (mismo límite documentado en el `down()` de `1784300000042` y `1784300000040`), y
   * para cuando alguien revierta esto podría ya haber filas en `NOTIFIED` que ese rebuild tendría
   * que resolver primero. Dejarlo de más no molesta a nadie: sólo los tres valores renombrados
   * vuelven a minúsculas.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // Orden inverso al de `up()`: el default sólo se puede fijar a 'pending' DESPUÉS de que esa
    // etiqueta vuelva a existir — hacerlo antes revienta con "invalid input value for enum"
    // porque en ese punto la única etiqueta pendiente todavía se llama 'PENDING'.
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'PENDING' TO 'pending'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'SIGNED' TO 'signed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" RENAME VALUE 'REJECTED' TO 'rejected'`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
  }
}
