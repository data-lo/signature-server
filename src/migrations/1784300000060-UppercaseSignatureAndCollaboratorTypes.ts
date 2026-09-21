import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pasa a mayúsculas las etiquetas de los tres enums de tipo de firma y tipo de colaborador, para
 * que el valor persistido, el que viaja por la API y el que compara el frontend sean el mismo
 * texto. Es el mismo trabajo que hizo `UppercaseCollaboratorStatusAddNotified` con
 * `collaborators_status_enum`, sobre los enums que quedaron fuera de aquella.
 *
 * `RENAME VALUE` y no `ADD VALUE` + `UPDATE`: los enums de Postgres se guardan por OID, no por
 * texto, así que renombrar una etiqueta hace que **cualquier fila existente se lea con el nombre
 * nuevo de inmediato**. No hay ningún `UPDATE` de datos que escribir, ni una ventana en la que
 * una fila quede con un valor que su tipo ya no admite.
 *
 * Los tres tipos son `collaborators_signature_type_enum`, `documents_signature_type_enum` —dos
 * tipos distintos aunque las dos columnas se llamen `signature_type`: TypeORM crea un enum por
 * columna— y `collaborators_colaborator_type_enum`. Ninguna de las tres columnas tiene DEFAULT,
 * así que no hay que reajustar ninguno (que es el paso extra que sí necesitó la migración del
 * estatus, cuyo default estaba guardado como el texto literal `'pending'`).
 *
 * `document_credit_consumptions_signature_type_enum` queda fuera porque ya nació en mayúsculas
 * (`SIMPLE`/`ADVANCED`, el vocabulario comercial). `notifications.actor_type` también queda
 * fuera: es otro enum, con otros valores (`watcher`/`account`), y esta historia nombra sólo el
 * tipo de firma y el tipo de colaborador.
 *
 * Corre transaccional: nunca escribe una fila con un valor recién declarado —sólo renombra
 * etiquetas que ya existen— así que no aplica la restricción 55P04 de Postgres, y un fallo a
 * medias revierte las siete sentencias juntas en vez de dejar los enums a medio renombrar.
 */
export class UppercaseSignatureAndCollaboratorTypes1784300000060 implements MigrationInterface {
  name = 'UppercaseSignatureAndCollaboratorTypes1784300000060';

  /**
   * Renombra a mayúsculas las etiquetas de los tres enums.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si alguna etiqueta no existe con su nombre en minúsculas — señal
   * de que la base ya está estandarizada o de que no viene del esquema esperado.
   *
   * @example
   * ```ts
   * await new UppercaseSignatureAndCollaboratorTypes1784300000060().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" RENAME VALUE 'simple' TO 'SIMPLE'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" RENAME VALUE 'fiel' TO 'FIEL'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" RENAME VALUE 'simple' TO 'SIMPLE'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" RENAME VALUE 'fiel' TO 'FIEL'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'signer' TO 'SIGNER'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'reviewer' TO 'REVIEWER'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'watcher' TO 'WATCHER'`,
    );
  }

  /**
   * Devuelve las siete etiquetas a minúsculas. Las filas vuelven a leerse con el nombre viejo por
   * lo mismo que en `up`: lo que cambia es la etiqueta, no el dato.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las etiquetas ya no existen con su nombre en mayúsculas.
   *
   * @example
   * ```ts
   * await new UppercaseSignatureAndCollaboratorTypes1784300000060().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'WATCHER' TO 'watcher'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'REVIEWER' TO 'reviewer'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'SIGNER' TO 'signer'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" RENAME VALUE 'FIEL' TO 'fiel'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" RENAME VALUE 'SIMPLE' TO 'simple'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" RENAME VALUE 'FIEL' TO 'fiel'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" RENAME VALUE 'SIMPLE' TO 'simple'`,
    );
  }
}
