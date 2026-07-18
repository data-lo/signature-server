import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 8 (ver plan de migración) — SOLO modelo de datos, sin ninguna lógica
 * de firma criptográfica. El diagrama objetivo únicamente especifica id/rfc/verificationCode/
 * verificationCodeRequired; no dice cómo ocurre la firma real. Qué proveedor de e.firma/PKI
 * mexicano se integra, cómo se manejan las llaves, y los requisitos de retención legal
 * específicos para documentos firmados con FIEL son decisiones de producto/legal pendientes
 * (ver TODO en fiel-signature.entity.ts) — esta tabla queda inerte hasta que se resuelvan.
 *
 * `collaborators.fiel_signature_id` ya existía como columna sin FK desde la Fase 4 (placeholder
 * polimórfico); aquí se completa con su FK real y con un CHECK que exige que a lo sumo una de
 * simple_signature_id/fiel_signature_id esté seteada (un colaborador no puede tener ambos
 * tipos de firma a la vez).
 */
export class CreateFielSignatures1784300000008 implements MigrationInterface {
  name = 'CreateFielSignatures1784300000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "fiel_signatures" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "rfc" character varying NOT NULL,
        "verification_code_id" uuid,
        "verification_code_required" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_fiel_signatures" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "fiel_signatures" ADD CONSTRAINT "FK_fiel_signatures_verification_code_id" FOREIGN KEY ("verification_code_id") REFERENCES "verification_codes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_fiel_signature_id" FOREIGN KEY ("fiel_signature_id") REFERENCES "fiel_signatures"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`
      ALTER TABLE "collaborators" ADD CONSTRAINT "CHK_collaborators_single_signature_type" CHECK (
        "simple_signature_id" IS NULL OR "fiel_signature_id" IS NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "CHK_collaborators_single_signature_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "FK_collaborators_fiel_signature_id"`,
    );
    await queryRunner.query(`DROP TABLE "fiel_signatures"`);
  }
}
