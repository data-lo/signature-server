import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `verification_record_digest` a `document_seals`: el SHA-256 en hexadecimal del XML de
 * auditoría del documento (sin `generatedAt`), calculado al terminar el sellado.
 *
 * Nullable: los sellos ya emitidos no lo tienen y no se calcula aquí (una migración no debe leer
 * MinIO). El `CHECK` garantiza que lo que se guarde sea un SHA-256 hex en minúsculas.
 */
export class AddVerificationRecordDigestToDocumentSeals1784300000100 implements MigrationInterface {
  name = 'AddVerificationRecordDigestToDocumentSeals1784300000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "document_seals" ADD COLUMN "verification_record_digest" character varying(64)',
    );
    await queryRunner.query(
      `ALTER TABLE "document_seals" ADD CONSTRAINT "CHK_document_seals_verification_record_digest" CHECK ("verification_record_digest" ~ '^[0-9a-f]{64}$')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "document_seals" DROP CONSTRAINT "CHK_document_seals_verification_record_digest"',
    );
    await queryRunner.query(
      'ALTER TABLE "document_seals" DROP COLUMN "verification_record_digest"',
    );
  }
}
