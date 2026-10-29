import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Firma biométrica con Didit para firmantes con y sin cuenta (historia "Implementar firma
 * biométrica con Didit para firmantes con y sin cuenta").
 *
 * 1. `BIOMETRIC` en los dos enums de tipo de firma (`collaborators` y `documents`: TypeORM crea un
 *    enum por columna).
 * 2. `guest_biometric_access` en `verification_codes_event_enum`: el código con el que un invitado
 *    sin cuenta acredita el correo de su invitación.
 * 3. La tabla `biometric_signature_attempts`, aparte de `identity_verifications`: aquélla es la
 *    identidad del onboarding; ésta, la autorización de UNA firma concreta, atada a documento,
 *    colaborador, hash del PDF y sesión de Didit. `user_id` e `identity_verification_id` son
 *    nulables porque un invitado no tiene ni una ni otra.
 *
 * Restricciones:
 * - `UQ_..._provider_session`: una sesión de Didit nunca puede aplicarse a dos intentos.
 * - `UQ_..._active` (parcial): un solo intento abierto por colaborador y hash. Cierra la carrera de
 *   dos "Firmar con biometría" simultáneos. Sus estados tienen que coincidir con
 *   `ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES`.
 * - `user_id` e `identity_verification_id` van con `ON DELETE SET NULL`: borrar al usuario no puede
 *   borrar la evidencia de una firma que ya produjo efectos.
 *
 * Sin `transaction = false`: los `ADD VALUE` sólo DECLARAN valores y ninguna sentencia escribe una
 * fila con ellos, así que no aplica la restricción 55P04 de Postgres (mismo criterio que
 * `AddApprovalEventTypes`).
 */
export class CreateBiometricSignatureAttempts1784300000069 implements MigrationInterface {
  name = 'CreateBiometricSignatureAttempts1784300000069';

  /**
   * Declara los valores de enum nuevos y crea la tabla de intentos con sus índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen los enums o las tablas referenciadas.
   *
   * @example
   * ```ts
   * await new CreateBiometricSignatureAttempts1784300000069().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" ADD VALUE IF NOT EXISTS 'BIOMETRIC'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" ADD VALUE IF NOT EXISTS 'BIOMETRIC'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."verification_codes_event_enum" ADD VALUE IF NOT EXISTS 'guest_biometric_access'`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."biometric_signature_attempts_provider_enum" AS ENUM('DIDIT')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."biometric_signature_attempts_status_enum" AS ENUM(
        'PENDING',
        'IN_PROGRESS',
        'APPROVED',
        'DECLINED',
        'EXPIRED',
        'FAILED'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE "biometric_signature_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "collaborator_id" uuid NOT NULL,
        "user_id" uuid,
        "email_snapshot" character varying NOT NULL,
        "identity_verification_id" uuid,
        "provider" "public"."biometric_signature_attempts_provider_enum" NOT NULL,
        "provider_session_id" character varying,
        "provider_workflow_id" character varying NOT NULL,
        "status" "public"."biometric_signature_attempts_status_enum" NOT NULL DEFAULT 'PENDING',
        "document_hash" character varying NOT NULL,
        "geolocation" jsonb NOT NULL,
        "ip_address" character varying,
        "consented_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "provider_metadata" jsonb,
        "decision" jsonb,
        "failure_reason" text,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_biometric_signature_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_biometric_signature_attempts_provider_session" UNIQUE ("provider", "provider_session_id"),
        CONSTRAINT "FK_biometric_signature_attempts_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_biometric_signature_attempts_collaborator_id"
          FOREIGN KEY ("collaborator_id") REFERENCES "collaborators"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_biometric_signature_attempts_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_biometric_signature_attempts_identity_verification_id"
          FOREIGN KEY ("identity_verification_id") REFERENCES "identity_verifications"("id") ON DELETE SET NULL
      )
    `);

    // "El último intento de este firmante": lo que consulta la pantalla en cada sondeo.
    await queryRunner.query(
      `CREATE INDEX "IDX_biometric_signature_attempts_collaborator_created" ON "biometric_signature_attempts" ("collaborator_id", "created_at")`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_biometric_signature_attempts_active" ON "biometric_signature_attempts" ("collaborator_id", "document_hash") WHERE "status" IN ('PENDING', 'IN_PROGRESS')`,
    );
  }

  /**
   * Borra la tabla y sus tipos.
   *
   * Los valores agregados a enums existentes (`BIOMETRIC`, `guest_biometric_access`) se quedan:
   * Postgres no elimina un valor sin recrear el tipo entero, y podría haber filas usándolos. Una
   * etiqueta de más no afecta a ningún consumidor.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla o los tipos ya no existen.
   *
   * @example
   * ```ts
   * await new CreateBiometricSignatureAttempts1784300000069().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "biometric_signature_attempts"`);
    await queryRunner.query(
      `DROP TYPE "public"."biometric_signature_attempts_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."biometric_signature_attempts_provider_enum"`,
    );
  }
}
