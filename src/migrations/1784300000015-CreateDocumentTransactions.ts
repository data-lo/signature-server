import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registro de Transacciones (Document Transaction) — ver diagrama ER-V2. Un registro inicial se
 * inserta al crear el documento (chainHash vacío); cada firma de un colaborador agrega un nuevo
 * registro cuyo chainHash es el actualHash del registro inmediato anterior de ese mismo documento.
 */
export class CreateDocumentTransactions1784300000015 implements MigrationInterface {
  name = 'CreateDocumentTransactions1784300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "collaborator_id" uuid,
        "actual_hash" character varying NOT NULL,
        "chain_hash" character varying NOT NULL DEFAULT '',
        "time_stamp" TIMESTAMP NOT NULL,
        "chipher" text NOT NULL,
        CONSTRAINT "PK_document_transactions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "document_transactions" ADD CONSTRAINT "FK_document_transactions_document_id" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_transactions" ADD CONSTRAINT "FK_document_transactions_collaborator_id" FOREIGN KEY ("collaborator_id") REFERENCES "collaborators"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_transactions_document_id" ON "document_transactions" ("document_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_transactions"`);
  }
}
