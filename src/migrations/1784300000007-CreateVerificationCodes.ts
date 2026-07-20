import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 7 (ver plan de migración): conecta el OTPService ya existente
 * (src/shared/otp/otp.service.ts, implementado desde antes de esta migración pero sin ningún
 * caller) a una tabla real con expiración/estado de uso persistidos.
 *
 * También elimina `documents.verification_code_id`: confirmado por grep de todo el código que
 * esa columna se declaró desde InitialSchema pero ningún caller la escribió jamás — limpieza
 * de columna muerta, no una migración de datos (no hay nada que preservar).
 */
export class CreateVerificationCodes1784300000007 implements MigrationInterface {
  name = 'CreateVerificationCodes1784300000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."verification_codes_event_enum" AS ENUM('sign_document', 'reject_document', 'cancel_document')`,
    );

    await queryRunner.query(`
      CREATE TABLE "verification_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying NOT NULL,
        "event" "public"."verification_codes_event_enum" NOT NULL,
        "is_used" boolean NOT NULL DEFAULT false,
        "used_at" TIMESTAMP,
        "ip_address" character varying NOT NULL,
        "expired_at" TIMESTAMP NOT NULL,
        "signer_id" uuid,
        "document_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_codes" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "verification_codes" ADD CONSTRAINT "FK_verification_codes_signer_id" FOREIGN KEY ("signer_id") REFERENCES "collaborators"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_codes" ADD CONSTRAINT "FK_verification_codes_document_id" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "simple_signatures" ADD CONSTRAINT "FK_simple_signatures_verification_code" FOREIGN KEY ("verification_code") REFERENCES "verification_codes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // Columna muerta desde su introducción (InitialSchema) — confirmado por grep, ningún
    // caller la escribió jamás. Se elimina en la misma migración que por fin le da un
    // reemplazo real (verification_codes), no antes.
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "verification_code_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "verification_code_id" character varying`,
    );

    await queryRunner.query(
      `ALTER TABLE "simple_signatures" DROP CONSTRAINT "FK_simple_signatures_verification_code"`,
    );

    await queryRunner.query(`DROP TABLE "verification_codes"`);
    await queryRunner.query(
      `DROP TYPE "public"."verification_codes_event_enum"`,
    );
  }
}
