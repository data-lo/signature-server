import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Huellas para la consulta pública `/verify`:
 * - `documents.final_document_digest`: SHA-256 hex del PDF final (con la hoja de firmas).
 * - Índices parciales sobre él y sobre `document_seals.verification_record_digest` (migración
 *   100), para encontrar el documento de un archivo por su SHA-256 sin recorrer la tabla.
 *
 * Parciales (`WHERE … IS NOT NULL`): la mayoría de las filas no tienen digest (documentos sin
 * firmar, sellos anteriores), y la búsqueda siempre es por un valor concreto. No son únicos: el
 * modelo no lo garantiza y una colisión de contenido no debe impedir cerrar un documento.
 *
 * La columna es nullable y no se rellena aquí: calcularla exige leer MinIO.
 */
export class AddFinalDocumentDigestAndVerificationIndexes1784300000101 implements MigrationInterface {
  name = 'AddFinalDocumentDigestAndVerificationIndexes1784300000101';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "documents" ADD COLUMN "final_document_digest" character varying(64)',
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_final_document_digest" CHECK ("final_document_digest" ~ '^[0-9a-f]{64}$')`,
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_documents_final_document_digest" ON "documents" ("final_document_digest") WHERE "final_document_digest" IS NOT NULL',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_document_seals_verification_record_digest" ON "document_seals" ("verification_record_digest") WHERE "verification_record_digest" IS NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "IDX_document_seals_verification_record_digest"',
    );
    await queryRunner.query('DROP INDEX "IDX_documents_final_document_digest"');
    await queryRunner.query(
      'ALTER TABLE "documents" DROP CONSTRAINT "CHK_documents_final_document_digest"',
    );
    await queryRunner.query(
      'ALTER TABLE "documents" DROP COLUMN "final_document_digest"',
    );
  }
}
