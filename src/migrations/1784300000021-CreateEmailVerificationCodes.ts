import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia "Auth: Flujo de Pre-registro, Verificación OTP y Control por CURP": tabla de OTPs de
 * verificación de correo de registro, keyed por `user_id` en vez de `document_id`/`signer_id`
 * (ver "verification_codes", que es la misma idea pero para firma de documentos). Se usa el
 * mismo `OTPService` genérico (src/shared/otp/otp.service.ts) para generar/comparar el código.
 */
export class CreateEmailVerificationCodes1784300000021
  implements MigrationInterface
{
  name = 'CreateEmailVerificationCodes1784300000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_verification_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying NOT NULL,
        "is_used" boolean NOT NULL DEFAULT false,
        "used_at" TIMESTAMP,
        "expired_at" TIMESTAMP NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_verification_codes" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "email_verification_codes" ADD CONSTRAINT "FK_email_verification_codes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_verification_codes"`);
  }
}
