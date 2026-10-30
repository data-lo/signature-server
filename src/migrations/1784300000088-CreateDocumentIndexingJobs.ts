import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `document_indexing_jobs`, la tabla de `DocumentIndexingJobEntity`: un trabajo por cada
 * evento `document.index` encolado, con el estado técnico de la indexación separado de
 * `documents.is_indexable`.
 *
 * El job se inserta en la misma transacción que el documento y la outbox. Sin esta tabla ese
 * `INSERT` falla y revierte la creación de todo documento indexable.
 *
 * - `status` arranca en `PENDING`; `RECEIVED`, `INDEXED` y `FAILED` los escribirá el webhook del
 *   indexador.
 * - `ON DELETE CASCADE`, como el resto de las tablas hijas de `documents`: borrar un documento no
 *   debe fallar por sus jobs.
 * - `IDX_document_indexing_jobs_document`: los jobs se buscan por documento.
 */
export class CreateDocumentIndexingJobs1784300000088 implements MigrationInterface {
  name = 'CreateDocumentIndexingJobs1784300000088';

  /**
   * Crea el enum de estados, la tabla y su índice por documento.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla o el enum ya existen, o no existe `documents`.
   *
   * @example
   * ```ts
   * await new CreateDocumentIndexingJobs1784300000088().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."document_indexing_jobs_status_enum" AS ENUM('PENDING', 'RECEIVED', 'INDEXED', 'FAILED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "document_indexing_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "external_job_id" character varying,
        "status" "public"."document_indexing_jobs_status_enum" NOT NULL DEFAULT 'PENDING',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "received_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "error" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_indexing_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_document_indexing_jobs_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_document_indexing_jobs_document" ON "document_indexing_jobs" ("document_id")`,
    );
  }

  /**
   * Borra la tabla y su enum. Se pierden los jobs registrados.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no existe.
   *
   * @example
   * ```ts
   * await new CreateDocumentIndexingJobs1784300000088().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_indexing_jobs"`);
    await queryRunner.query(
      `DROP TYPE "public"."document_indexing_jobs_status_enum"`,
    );
  }
}
