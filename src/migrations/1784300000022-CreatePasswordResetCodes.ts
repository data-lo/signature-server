import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia "Recuperación de Contraseña mediante Código de Verificación OTP": tabla de
 * OTPs de recuperación de contraseña, keyed por `user_id` en vez de
 * `document_id`/`signer_id` (ver "verification_codes", la misma idea pero para firma
 * de documentos). Se usa el mismo `OTPService` genérico (src/shared/otp/otp.service.ts)
 * para generar/comparar el código.
 */
export class CreatePasswordResetCodes1784300000022 implements MigrationInterface {
  name = 'CreatePasswordResetCodes1784300000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "password_reset_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying NOT NULL,
        "is_used" boolean NOT NULL DEFAULT false,
        "used_at" TIMESTAMP,
        "expired_at" TIMESTAMP NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_password_reset_codes" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "password_reset_codes" ADD CONSTRAINT "FK_password_reset_codes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "password_reset_codes"`);
  }
}
