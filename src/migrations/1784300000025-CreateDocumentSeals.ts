import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDocumentSeals1784300000025 implements MigrationInterface {
  name = 'CreateDocumentSeals1784300000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_seals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "signature_hash" character varying NOT NULL,
        "canonical_payload" text NOT NULL,
        "timestamp_evidence" jsonb NOT NULL,
        "nom151_evidence" jsonb NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_seals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_document_seals_document_id" UNIQUE ("document_id"),
        CONSTRAINT "FK_document_seals_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "document_seals"');
  }
}
