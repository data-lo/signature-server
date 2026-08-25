import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Verificación de identidad con proveedor externo (módulo `identity-verification`), más las dos
 * columnas que la regla de credencial de firma necesita en `users`.
 *
 * `signing_credential_configured` es un valor derivado que se persiste
 * (`identity APPROVED && signature_id IS NOT NULL`): se materializa para que la pantalla y el
 * cache de perfil no tengan que recalcularlo en cada lectura, y lo mantiene un único caso de
 * uso, `RefreshSigningCredentialStatusUseCase`.
 */
export class CreateIdentityVerifications1784300000028 implements MigrationInterface {
  name = 'CreateIdentityVerifications1784300000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."identity_verifications_provider_enum" AS ENUM('DIDIT')`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."identity_verifications_status_enum" AS ENUM(
        'PENDING',
        'IN_PROGRESS',
        'APPROVED',
        'DECLINED',
        'IN_REVIEW',
        'ABANDONED',
        'EXPIRED',
        'FAILED'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE "identity_verifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "provider" "public"."identity_verifications_provider_enum" NOT NULL,
        "status" "public"."identity_verifications_status_enum" NOT NULL DEFAULT 'PENDING',
        "provider_session_id" character varying,
        "provider_workflow_id" character varying,
        "provider_metadata" jsonb,
        "decision" jsonb,
        "failure_reason" text,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_identity_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_identity_verifications_provider_session" UNIQUE ("provider", "provider_session_id"),
        CONSTRAINT "FK_identity_verifications_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // "El último intento del usuario": lo que resuelve la pantalla en cada carga.
    await queryRunner.query(
      `CREATE INDEX "IDX_identity_verifications_user_created" ON "identity_verifications" ("user_id", "created_at")`,
    );

    // "¿Este usuario tiene alguna verificación APPROVED?": la pregunta de
    // AssertIdentityApprovedUseCase, en el camino crítico de subir la firma.
    await queryRunner.query(
      `CREATE INDEX "IDX_identity_verifications_user_status" ON "identity_verifications" ("user_id", "status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD "signing_credential_configured" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "identity_verified_at" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "identity_verified_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "signing_credential_configured"`,
    );
    await queryRunner.query(`DROP TABLE "identity_verifications"`);
    await queryRunner.query(
      `DROP TYPE "public"."identity_verifications_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."identity_verifications_provider_enum"`,
    );
  }
}
