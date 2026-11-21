import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `document_sealing_jobs`, la tabla de `DocumentSealingJobEntity`: un trabajo persistente de
 * sellado por documento, registrado en la misma transacción que deja el documento en `SIGNED`.
 *
 * - `status`, `phase` y `seal_type` son `varchar` con un `CHECK` de sus valores, no enums de
 *   Postgres: agregar un valor no exige `ALTER TYPE`.
 * - `UQ_document_sealing_jobs_document_id`: un trabajo por documento. El registro hace
 *   `ON CONFLICT DO NOTHING` contra ella y relee el existente.
 * - `CHK_document_sealing_jobs_attempt_count`: `attempt_count >= 0`.
 * - `IDX_document_sealing_jobs_claimable`: parcial sobre `next_attempt_at` para `PENDING` y
 *   `RETRY_SCHEDULED`, la búsqueda del worker.
 * - `IDX_document_sealing_jobs_expired_lease`: parcial sobre `lease_expires_at` para `PROCESSING`,
 *   para recuperar trabajos de un worker interrumpido.
 * - `ON DELETE CASCADE`, como el resto de las tablas hijas de `documents`.
 *
 * Los nombres son los de `DOCUMENT_SEALING_JOB_CONSTRAINTS` en la entidad. No hay backfill: los
 * documentos firmados antes de esta migración conservan su flujo anterior
 * (`documents.sealing_pending_at` y la vista pública).
 */
export class CreateDocumentSealingJobs1784300000099 implements MigrationInterface {
  name = 'CreateDocumentSealingJobs1784300000099';

  /**
   * Crea la tabla, sus restricciones y sus dos índices parciales.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla ya existe o no existe `documents`.
   *
   * @example
   * ```ts
   * await new CreateDocumentSealingJobs1784300000099().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_sealing_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "seal_type" character varying(32) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'PENDING',
        "phase" character varying(32) NOT NULL,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lease_token" uuid,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "request_object_key" character varying(512),
        "request_hash" character varying(64),
        "last_error_code" character varying(64),
        "last_error_message" text,
        "last_upstream_status" integer,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_sealing_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_document_sealing_jobs_document_id" UNIQUE ("document_id"),
        CONSTRAINT "CHK_document_sealing_jobs_attempt_count" CHECK ("attempt_count" >= 0),
        CONSTRAINT "CHK_document_sealing_jobs_status" CHECK ("status" IN ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'COMPLETED', 'DEAD', 'RECONCILIATION_REQUIRED')),
        CONSTRAINT "CHK_document_sealing_jobs_phase" CHECK ("phase" IN ('VERIFYING_OCSP', 'GENERATING_SEAL', 'UPDATING_EVIDENCE_PDF')),
        CONSTRAINT "CHK_document_sealing_jobs_seal_type" CHECK ("seal_type" IN ('ADVANCED', 'SIMPLE')),
        CONSTRAINT "FK_document_sealing_jobs_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_document_sealing_jobs_claimable" ON "document_sealing_jobs" ("next_attempt_at") WHERE "status" IN ('PENDING', 'RETRY_SCHEDULED')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_sealing_jobs_expired_lease" ON "document_sealing_jobs" ("lease_expires_at") WHERE "status" = 'PROCESSING'`,
    );
  }

  /**
   * Borra la tabla con sus índices. Se pierden los trabajos registrados; los payloads congelados
   * siguen en el bucket `sealing-requests`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no existe.
   *
   * @example
   * ```ts
   * await new CreateDocumentSealingJobs1784300000099().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_sealing_jobs"`);
  }
}
