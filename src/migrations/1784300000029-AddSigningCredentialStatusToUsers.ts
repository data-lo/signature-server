import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reemplaza la bandera booleana `users.signing_credential_configured` por el estado global
 * `users.signing_credential_status`.
 *
 * La bandera sólo distinguía "listo / no listo" y obligaba a cruzarla con la tabla de
 * verificaciones para saber qué le faltaba al usuario. El enum expresa el avance completo, lo
 * escribe un único caso de uso (`UpdateSigningCredentialStatusUseCase`) y la bandera anterior
 * pasa a derivarse (`status === 'CONFIGURED'`), de modo que no hay dos fuentes de verdad.
 *
 * El backfill reconstruye el estado de cada usuario a partir de lo que ya existía en la base:
 * la credencial configurada, la identidad aprobada y, si no hay ninguna de las dos, el último
 * intento registrado. Un usuario sin intentos queda en el valor inicial.
 */
export class AddSigningCredentialStatusToUsers1784300000029 implements MigrationInterface {
  name = 'AddSigningCredentialStatusToUsers1784300000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_signing_credential_status_enum" AS ENUM(
        'IDENTITY_VERIFICATION_REQUIRED',
        'IDENTITY_VERIFICATION_PENDING',
        'IDENTITY_VERIFICATION_IN_PROGRESS',
        'IDENTITY_VERIFICATION_IN_REVIEW',
        'IDENTITY_VERIFICATION_RETRY_REQUIRED',
        'IDENTITY_VERIFICATION_FAILED',
        'IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED',
        'SIGNATURE_PENDING',
        'CONFIGURED'
      )`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD "signing_credential_status" "public"."users_signing_credential_status_enum" NOT NULL DEFAULT 'IDENTITY_VERIFICATION_REQUIRED'`,
    );

    // Credencial ya completa: identidad aprobada y firma PNG registrada.
    await queryRunner.query(`
      UPDATE "users"
      SET "signing_credential_status" = 'CONFIGURED'
      WHERE "signing_credential_configured" = true
    `);

    // Identidad aprobada alguna vez, pero sin firma PNG: sólo le falta subirla.
    await queryRunner.query(`
      UPDATE "users" u
      SET "signing_credential_status" = 'SIGNATURE_PENDING'
      WHERE u."signing_credential_configured" = false
        AND EXISTS (
          SELECT 1 FROM "identity_verifications" iv
          WHERE iv."user_id" = u."id" AND iv."status" = 'APPROVED'
        )
    `);

    /**
     * El resto se deduce del último intento. Los estados terminales sin aprobación (rechazo,
     * abandono, expiración, error) se agrupan en RETRY_REQUIRED, que es lo que el usuario puede
     * hacer al respecto: volver a intentarlo.
     */
    await queryRunner.query(`
      UPDATE "users" u
      SET "signing_credential_status" = CASE latest."status"
        WHEN 'PENDING' THEN 'IDENTITY_VERIFICATION_PENDING'
        WHEN 'IN_PROGRESS' THEN 'IDENTITY_VERIFICATION_IN_PROGRESS'
        WHEN 'IN_REVIEW' THEN 'IDENTITY_VERIFICATION_IN_REVIEW'
        ELSE 'IDENTITY_VERIFICATION_RETRY_REQUIRED'
      END::"public"."users_signing_credential_status_enum"
      FROM (
        SELECT DISTINCT ON (iv."user_id") iv."user_id", iv."status"
        FROM "identity_verifications" iv
        ORDER BY iv."user_id", iv."created_at" DESC
      ) AS latest
      WHERE latest."user_id" = u."id"
        AND u."signing_credential_status" = 'IDENTITY_VERIFICATION_REQUIRED'
    `);

    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "signing_credential_configured"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "signing_credential_configured" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(`
      UPDATE "users"
      SET "signing_credential_configured" = true
      WHERE "signing_credential_status" = 'CONFIGURED'
    `);

    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "signing_credential_status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."users_signing_credential_status_enum"`,
    );
  }
}
