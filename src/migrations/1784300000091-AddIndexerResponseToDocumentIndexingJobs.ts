import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prepara `document_indexing_jobs` para procesar el webhook del indexador.
 *
 * - `external_document_id`: el `documentId` que asigna el indexador. Sólo se guarda; el job se busca
 *   por `clientDocumentId`, que es nuestro `documents.id`.
 * - `UQ_document_indexing_jobs_active`: un solo job activo por documento. El contrato del indexador
 *   identifica el documento y no el job, así que dos activos harían ambigua la correlación.
 */
export class AddIndexerResponseToDocumentIndexingJobs1784300000091 implements MigrationInterface {
  name = 'AddIndexerResponseToDocumentIndexingJobs1784300000091';

  /**
   * Agrega la columna y el índice único parcial.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si ya hay dos jobs activos para un mismo documento.
   *
   * @example
   * ```ts
   * await new AddIndexerResponseToDocumentIndexingJobs1784300000091().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_indexing_jobs" ADD "external_document_id" character varying`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_document_indexing_jobs_active" ON "document_indexing_jobs" ("document_id") WHERE "status" IN ('PENDING', 'RECEIVED')`,
    );
  }

  /**
   * Quita el índice y la columna. Se pierden los `external_document_id` registrados.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si el índice o la columna no existen.
   *
   * @example
   * ```ts
   * await new AddIndexerResponseToDocumentIndexingJobs1784300000091().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_document_indexing_jobs_active"`);
    await queryRunner.query(
      `ALTER TABLE "document_indexing_jobs" DROP COLUMN "external_document_id"`,
    );
  }
}
