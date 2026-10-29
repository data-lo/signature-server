import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Parte el estado `pending` del documento en dos —`PENDING_APPROVAL` y `PENDING_SIGNATURE`— y
 * estandariza el resto del enum en mayúsculas (historia "Implementar flujo de aprobación previo
 * al proceso de firma").
 *
 * El punto de la historia: hasta ahora "pendiente" sólo podía significar "esperando firmas",
 * porque era el único tipo de espera que existía. Con la aprobación previa hay dos esperas
 * distintas —la del reviewer y la de los firmantes— y un solo estado para ambas haría imposible
 * responder la pregunta que gobierna todo el flujo: si este documento ya se puede firmar.
 *
 * **Los documentos existentes se migran renombrando la etiqueta, no con un `UPDATE`.** Los enums
 * de Postgres se guardan por OID: al renombrar `pending` a `PENDING_SIGNATURE`, las 594 filas que
 * hoy dicen `pending` pasan a leerse como `PENDING_SIGNATURE` de inmediato, que es exactamente
 * donde tienen que quedar —pertenecen al flujo de firma actual, no a una aprobación que todavía
 * no existía cuando se crearon—. No hay ventana en la que una fila quede con un valor que su tipo
 * no admite, ni filas que se queden atrás si la tabla crece entre la lectura y la escritura.
 *
 * `PENDING_APPROVAL` se agrega como etiqueta nueva porque ningún documento anterior puede estar
 * en ese estado: es imposible haber entrado a un flujo que no existía.
 *
 * El `SET DEFAULT` va aparte y no sobra: `RENAME VALUE` no retoca el default de la columna, que
 * se queda guardado como el texto literal `'created'` (mismo detalle que documentó
 * `UppercaseCollaboratorStatusAddNotified`).
 */
export class UppercaseDocumentStatusAddApprovalStates1784300000059 implements MigrationInterface {
  name = 'UppercaseDocumentStatusAddApprovalStates1784300000059';

  /**
   * Renombra las siete etiquetas —`pending` se convierte en `PENDING_SIGNATURE`— y declara
   * `PENDING_APPROVAL`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si alguna etiqueta no existe con su nombre en minúsculas.
   *
   * @example
   * ```ts
   * await new UppercaseDocumentStatusAddApprovalStates1784300000059().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'pending' TO 'PENDING_SIGNATURE'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'created' TO 'CREATED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'signed' TO 'SIGNED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'rejected' TO 'REJECTED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'expired' TO 'EXPIRED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'cancellation_pending' TO 'CANCELLATION_PENDING'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'cancelled' TO 'CANCELLED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL'`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'CREATED'`,
    );
  }

  /**
   * Deshace los renombres y devuelve el default a `'created'`.
   *
   * `PENDING_APPROVAL` **no se quita**: Postgres no sabe eliminar un valor de enum sin recrear el
   * tipo completo (mismo límite que documentan los `down()` de `1784300000040`, `1784300000042` y
   * `1784300000053`), y para cuando alguien revierta esto podría haber documentos en ese estado
   * que el rebuild tendría que resolver primero. Dejar la etiqueta de más no molesta a nadie; lo
   * que sí importa es que `PENDING_SIGNATURE` vuelva a llamarse `pending`, porque es el valor que
   * el código anterior sabe leer.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las etiquetas ya no existen con su nombre en mayúsculas.
   *
   * @example
   * ```ts
   * await new UppercaseDocumentStatusAddApprovalStates1784300000059().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // El default se fija DESPUÉS de que 'created' vuelva a existir: al revés revienta con
    // "invalid input value for enum", porque en ese punto la etiqueta todavía se llama 'CREATED'.
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'PENDING_SIGNATURE' TO 'pending'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'CREATED' TO 'created'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'SIGNED' TO 'signed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'REJECTED' TO 'rejected'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'EXPIRED' TO 'expired'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'CANCELLATION_PENDING' TO 'cancellation_pending'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_status_enum" RENAME VALUE 'CANCELLED' TO 'cancelled'`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'created'`,
    );
  }
}
