import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prepara `collaborators` para el flujo de aprobación: `signed_at` pasa a `resolved_at`, aparece
 * `resolution_note` y el enum de estatus gana `APPROVED` (historia "Implementar flujo de
 * aprobación previo al proceso de firma").
 *
 * **Por qué `resolved_at` y no una columna nueva al lado de `signed_at`.** La fecha que guarda
 * esa columna nunca fue "cuándo firmó" sino "cuándo terminó su participación": un SIGNER que
 * rechaza también la escribe. Con el REVIEWER entrando al modelo, el nombre viejo pasaría a
 * mentir en la mitad de las filas —un aprobador no firma nada— y la alternativa, una segunda
 * columna de fecha, obligaría a todo consumidor a preguntar antes por el tipo de colaborador
 * para saber cuál de las dos leer. Una sola fecha con el nombre correcto evita las dos cosas.
 *
 * El renombre es `ALTER TABLE ... RENAME COLUMN`: Postgres lo resuelve en el catálogo sin
 * reescribir la tabla, así que **las fechas existentes se conservan por construcción** y los
 * índices o constraints que colgaran de la columna la siguen.
 *
 * `APPROVED` se agrega al enum que ya comparten todos los colaboradores en vez de crear uno
 * propio para el reviewer: `status` es una sola columna y darle dos tipos según la fila no es
 * expresable en Postgres. Qué valores puede tomar cada tipo de colaborador es una regla de
 * dominio —REVIEWER: PENDING/APPROVED/REJECTED; SIGNER: PENDING/SIGNED/REJECTED— y vive donde se
 * puede leer junto al resto de las reglas, en `COLLABORATOR_STATUS_ENUM`.
 */
export class AddCollaboratorApprovalFields1784300000060 implements MigrationInterface {
  name = 'AddCollaboratorApprovalFields1784300000060';

  /**
   * Renombra `signed_at`, agrega `resolution_note` y declara `APPROVED`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si `signed_at` no existe — señal de que la base no viene del
   * esquema esperado y hay que revisarla antes de seguir.
   *
   * @example
   * ```ts
   * await new AddCollaboratorApprovalFields1784300000060().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "signed_at" TO "resolved_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD COLUMN IF NOT EXISTS "resolution_note" text`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_status_enum" ADD VALUE IF NOT EXISTS 'APPROVED'`,
    );
  }

  /**
   * Devuelve la columna a `signed_at` y elimina `resolution_note`.
   *
   * Las fechas vuelven intactas, por lo mismo que en `up`. Lo que se pierde al revertir son las
   * notas de resolución, que no tienen dónde vivir en el esquema anterior. `APPROVED` se queda en
   * el enum por el límite de Postgres para quitar valores, y porque podría haber reviewers en ese
   * estado.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si `resolved_at` ya no existe con ese nombre.
   *
   * @example
   * ```ts
   * await new AddCollaboratorApprovalFields1784300000060().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN IF EXISTS "resolution_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "resolved_at" TO "signed_at"`,
    );
  }
}
