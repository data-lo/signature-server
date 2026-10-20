import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Autorización de invitados para Firma Electrónica Avanzada con y sin cuenta (historia
 * "Autorización de invitado para Firma Avanzada con y sin cuenta").
 *
 * 1. `guest_advanced_signature_access` en `verification_codes_event_enum`: el código con el que el
 *    invitado acredita el control del correo de su invitación.
 * 2. La tabla `guest_signing_accesses`: el acceso temporal que se emite al canjear ese código. Su
 *    `id` es el `jti` del token del invitado, así que un token ya entregado se puede revocar o dar
 *    por consumido desde aquí.
 * 3. `collaborators.signing_authorization`: cómo se acreditó el firmante al firmar (sesión de
 *    cuenta o código del correo). Evidencia, no estado: no distingue "con cuenta" de "sin cuenta"
 *    mientras la firma está pendiente —eso sigue derivándose de `account_id`—.
 *
 * Restricciones de `guest_signing_accesses`:
 * - `UQ_guest_signing_accesses_open` (parcial): a lo sumo un acceso sin consumir ni revocar por
 *   documento + colaborador + propósito. La vigencia (`expires_at`) no puede entrar en el índice
 *   —`now()` no es inmutable—, así que uno vencido sigue ocupando el lugar hasta que se revoca; por
 *   eso emitir uno nuevo revoca antes TODOS los abiertos, vencidos incluidos. Cierra además la
 *   carrera de dos canjes simultáneos del mismo código.
 * - `CHK_guest_signing_accesses_closed_once`: un acceso termina de una sola forma, consumido o
 *   revocado, nunca las dos.
 * - `CHK_guest_signing_accesses_expiry`: vence después de emitirse.
 *
 * Sin `transaction = false`: el `ADD VALUE` sólo declara el valor y ninguna sentencia de esta
 * migración escribe una fila con él (mismo criterio que `CreateBiometricSignatureAttempts`).
 */
export class CreateGuestSigningAccesses1784300000075 implements MigrationInterface {
  name = 'CreateGuestSigningAccesses1784300000075';

  /**
   * Declara el evento de código, crea la tabla de accesos y la columna de evidencia.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen los enums o las tablas referenciadas.
   *
   * @example
   * ```ts
   * await new CreateGuestSigningAccesses1784300000075().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."verification_codes_event_enum" ADD VALUE IF NOT EXISTS 'guest_advanced_signature_access'`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."guest_signing_accesses_purpose_enum" AS ENUM('GUEST_ADVANCED_SIGNATURE_ACCESS')`,
    );

    await queryRunner.query(`
      CREATE TABLE "guest_signing_accesses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "collaborator_id" uuid NOT NULL,
        "email_hash" character varying(64) NOT NULL,
        "purpose" "public"."guest_signing_accesses_purpose_enum" NOT NULL,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "issued_ip_address" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guest_signing_accesses" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_guest_signing_accesses_closed_once"
          CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL),
        CONSTRAINT "CHK_guest_signing_accesses_expiry"
          CHECK ("expires_at" > "issued_at"),
        CONSTRAINT "FK_guest_signing_accesses_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_guest_signing_accesses_collaborator_id"
          FOREIGN KEY ("collaborator_id") REFERENCES "collaborators"("id") ON DELETE CASCADE
      )
    `);

    // Revocar por colaborador (vincular cuenta, firmar) es la consulta más frecuente.
    await queryRunner.query(
      `CREATE INDEX "IDX_guest_signing_accesses_collaborator" ON "guest_signing_accesses" ("collaborator_id")`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_guest_signing_accesses_open" ON "guest_signing_accesses" ("document_id", "collaborator_id", "purpose") WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_signing_authorization_enum" AS ENUM('ACCOUNT_SESSION', 'GUEST_EMAIL_OTP')`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD "signing_authorization" "public"."collaborators_signing_authorization_enum"`,
    );
  }

  /**
   * Quita la columna de evidencia, la tabla de accesos y sus tipos.
   *
   * El valor `guest_advanced_signature_access` se queda en `verification_codes_event_enum`:
   * Postgres no elimina un valor sin recrear el tipo, y puede haber códigos emitidos con él.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla, la columna o los tipos ya no existen.
   *
   * @example
   * ```ts
   * await new CreateGuestSigningAccesses1784300000075().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN "signing_authorization"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."collaborators_signing_authorization_enum"`,
    );
    await queryRunner.query(`DROP TABLE "guest_signing_accesses"`);
    await queryRunner.query(
      `DROP TYPE "public"."guest_signing_accesses_purpose_enum"`,
    );
  }
}
