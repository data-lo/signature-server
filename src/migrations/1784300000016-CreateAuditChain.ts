import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo de Auditoría e Integridad Global de BD (ver diagrama ER-V2, entidad "audit"): ledger
 * global de solo-inserción, encadenado por hash sobre TODA la base de datos (no por documento).
 * `id` es serial (int autoincremental) a propósito — "MAX(id) global" es la fuente de verdad
 * barata para "cuál es la última fila" que usa AuditChainService bajo un advisory lock.
 */
export class CreateAuditChain1784300000016 implements MigrationInterface {
  name = 'CreateAuditChain1784300000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."audit_audit_type_enum" AS ENUM('created', 'pending', 'aproved_to_sign', 'signatures_partial', 'signatures_completed', 'rejected')`,
    );

    await queryRunner.query(`
      CREATE TABLE "audit" (
        "id" SERIAL NOT NULL,
        "document_id" uuid,
        "chipher" text NOT NULL,
        "actual_hash" character varying NOT NULL,
        "chain_hash" character varying NOT NULL,
        "audit_type" "public"."audit_audit_type_enum" NOT NULL,
        "timestamp" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_audit" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "audit" ADD CONSTRAINT "FK_audit_document_id" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_document_id" ON "audit" ("document_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit"`);
    await queryRunner.query(`DROP TYPE "public"."audit_audit_type_enum"`);
  }
}
