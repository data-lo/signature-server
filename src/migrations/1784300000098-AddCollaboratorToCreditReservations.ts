import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reservas biométricas por colaborador, sin necesidad de un intento de Didit.
 *
 * Hasta la 093 una reserva biométrica existía sólo por su intento (`biometric_signature_attempt_id`
 * obligatorio). Desde aquí se aparta un crédito por cada colaborador biométrico del documento, y
 * el intento se le asocia cuando el colaborador abre su sesión.
 *
 * - `credit_reservations.collaborator_id`, con FK compuesta `(collaborator_id, document_id)` →
 *   `collaborators (id, document_id)`: el colaborador tiene que ser del mismo documento. Para eso
 *   `collaborators` gana el `UNIQUE (id, document_id)` que la FK necesita (trivial: `id` ya es PK).
 * - Backfill: cada reserva biométrica histórica toma `collaborator_id` y `document_id` de su
 *   intento. Ninguna fila se borra ni cambia de estado, saldo o lote.
 * - `CHK_credit_reservations_subject`: la documental exige documento y no lleva colaborador; la
 *   biométrica exige documento y colaborador, y el intento pasa a ser opcional.
 * - `CHK_credit_reservations_biometric_quantity`: una biométrica bloquea exactamente 1 crédito.
 * - `UQ_credit_reservations_active_biometric_collaborator`: una sola biométrica `ACTIVE` por
 *   colaborador y documento. La de un solo intento activo (`..._active_biometric_attempt`) se
 *   conserva.
 *
 * Antes de crear restricciones se comprueba que los datos históricos las cumplen; si no, la
 * migración se detiene con un mensaje claro y la transacción no deja nada a medias.
 */
export class AddCollaboratorToCreditReservations1784300000098 implements MigrationInterface {
  name = 'AddCollaboratorToCreditReservations1784300000098';

  /**
   * Agrega la columna, hace el backfill desde los intentos y endurece las restricciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si alguna reserva biométrica histórica no puede asociarse a un colaborador, no
   *   bloquea exactamente 1 crédito, o si un mismo colaborador tiene más de una reserva biométrica
   *   activa en el mismo documento.
   * @throws {QueryFailedError} Si no existen `credit_reservations`, `collaborators` o
   *   `biometric_signature_attempts`.
   *
   * @example
   * ```ts
   * await new AddCollaboratorToCreditReservations1784300000098().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "credit_reservations" ADD COLUMN "collaborator_id" uuid`,
    );

    await queryRunner.query(`
      UPDATE "credit_reservations" r
         SET "collaborator_id" = a."collaborator_id",
             "document_id" = COALESCE(r."document_id", a."document_id")
        FROM "biometric_signature_attempts" a
       WHERE a."id" = r."biometric_signature_attempt_id"
         AND r."credit_type" = 'BIOMETRIC_SIGNATURE'
    `);

    await this.assertNone(
      queryRunner,
      `SELECT count(*) AS "count" FROM "credit_reservations"
        WHERE "credit_type" = 'BIOMETRIC_SIGNATURE'
          AND ("collaborator_id" IS NULL OR "document_id" IS NULL)`,
      'reserva(s) biométrica(s) sin colaborador o documento tras el backfill desde su intento',
    );
    await this.assertNone(
      queryRunner,
      `SELECT count(*) AS "count" FROM "credit_reservations"
        WHERE "credit_type" = 'BIOMETRIC_SIGNATURE' AND "quantity" <> 1`,
      'reserva(s) biométrica(s) que no bloquean exactamente 1 crédito',
    );
    await this.assertNone(
      queryRunner,
      `SELECT count(*) AS "count" FROM (
         SELECT 1 FROM "credit_reservations"
          WHERE "credit_type" = 'BIOMETRIC_SIGNATURE' AND "status" = 'ACTIVE'
          GROUP BY "document_id", "collaborator_id"
         HAVING count(*) > 1
       ) duplicated`,
      'colaborador(es) con más de una reserva biométrica activa en el mismo documento; resuélvalas antes de migrar',
    );

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "UQ_collaborators_id_document" UNIQUE ("id", "document_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "credit_reservations"
        ADD CONSTRAINT "FK_credit_reservations_collaborator"
          FOREIGN KEY ("collaborator_id", "document_id")
          REFERENCES "collaborators"("id", "document_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        DROP CONSTRAINT "CHK_credit_reservations_subject",
        ADD CONSTRAINT "CHK_credit_reservations_subject" CHECK (
          ("credit_type" = 'DOCUMENT_SIGNATURE' AND "document_id" IS NOT NULL AND "collaborator_id" IS NULL)
          OR ("credit_type" = 'BIOMETRIC_SIGNATURE' AND "document_id" IS NOT NULL AND "collaborator_id" IS NOT NULL)
        ),
        ADD CONSTRAINT "CHK_credit_reservations_biometric_quantity" CHECK (
          "credit_type" <> 'BIOMETRIC_SIGNATURE' OR "quantity" = 1
        )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_credit_reservations_active_biometric_collaborator" ON "credit_reservations" ("document_id", "collaborator_id") WHERE "status" = 'ACTIVE' AND "credit_type" = 'BIOMETRIC_SIGNATURE'`,
    );
  }

  /**
   * Vuelve al modelo de reserva por intento: quita índice, restricciones y columna.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si hay reservas biométricas sin intento: el esquema anterior no puede
   *   representarlas y borrarlas perdería saldo bloqueado.
   *
   * @example
   * ```ts
   * await new AddCollaboratorToCreditReservations1784300000098().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertNone(
      queryRunner,
      `SELECT count(*) AS "count" FROM "credit_reservations"
        WHERE "credit_type" = 'BIOMETRIC_SIGNATURE' AND "biometric_signature_attempt_id" IS NULL`,
      'reserva(s) biométrica(s) sin intento de Didit; el esquema anterior no puede representarlas',
    );

    await queryRunner.query(
      `DROP INDEX "UQ_credit_reservations_active_biometric_collaborator"`,
    );
    await queryRunner.query(`
      ALTER TABLE "credit_reservations"
        DROP CONSTRAINT "CHK_credit_reservations_biometric_quantity",
        DROP CONSTRAINT "CHK_credit_reservations_subject",
        ADD CONSTRAINT "CHK_credit_reservations_subject" CHECK (
          ("credit_type" = 'DOCUMENT_SIGNATURE' AND "document_id" IS NOT NULL)
          OR ("credit_type" = 'BIOMETRIC_SIGNATURE' AND "biometric_signature_attempt_id" IS NOT NULL)
        ),
        DROP CONSTRAINT "FK_credit_reservations_collaborator",
        DROP COLUMN "collaborator_id"
    `);
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "UQ_collaborators_id_document"`,
    );
  }

  /**
   * Detiene la migración si la consulta cuenta alguna fila.
   *
   * @param queryRunner - Conexión de la migración.
   * @param sql - Consulta que devuelve una fila con `count`.
   * @param problem - Qué significan las filas contadas, para el mensaje.
   * @returns Nada.
   *
   * @throws {Error} Si `count > 0`.
   *
   * @example
   * ```ts
   * await this.assertNone(queryRunner, 'SELECT count(*) AS "count" FROM t WHERE …', 'filas inválidas');
   * ```
   */
  private async assertNone(
    queryRunner: QueryRunner,
    sql: string,
    problem: string,
  ): Promise<void> {
    const [row] = await queryRunner.query(sql);
    const count = Number(row?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `No se puede migrar credit_reservations: ${count} ${problem}.`,
      );
    }
  }
}
