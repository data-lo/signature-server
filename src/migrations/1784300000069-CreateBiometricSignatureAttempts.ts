import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Firma biométrica con Didit (historia "Iniciar flujo de firma biométrica con Didit para usuarios
 * autenticados"): la tabla de intentos y el valor `BIOMETRIC` en los dos enums de tipo de firma.
 *
 * `biometric_signature_attempts` es deliberadamente una tabla aparte de `identity_verifications`:
 * aquélla es la identidad del onboarding; ésta, la autorización de UNA firma concreta, atada a un
 * documento, a un colaborador, a un usuario y al hash del PDF que aceptó firmar.
 *
 * Dos restricciones únicas, con propósitos distintos:
 * - `UQ_..._provider_session` (proveedor + sesión): una sesión de Didit nunca puede aplicarse a dos
 *   intentos, que es lo que haría ambiguo a quién le corresponde el webhook.
 * - `UQ_..._active_collaborator` (parcial): un colaborador no puede tener dos intentos abiertos a la
 *   vez. Es lo que cierra la carrera de dos "Firmar con biometría" casi simultáneos (doble clic, dos
 *   pestañas): el segundo `INSERT` choca y el caso de uso devuelve la sesión del primero en vez de
 *   abrir —y pagar— otra en Didit. La lista de estados tiene que coincidir con
 *   `ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES`.
 *
 * Sin `transaction = false`: los `ADD VALUE` sólo DECLARAN `BIOMETRIC` y ninguna sentencia de esta
 * migración escribe una fila con él, así que no aplica la restricción 55P04 de Postgres (mismo
 * criterio que `AddApprovalEventTypes`).
 */
export class CreateBiometricSignatureAttempts1784300000069 implements MigrationInterface {
  name = 'CreateBiometricSignatureAttempts1784300000069';

  /**
   * Declara `BIOMETRIC` en los enums de tipo de firma y crea la tabla de intentos con sus índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen los enums de tipo de firma o las tablas referenciadas.
   *
   * @example
   * ```ts
   * await new CreateBiometricSignatureAttempts1784300000069().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dos tipos distintos aunque las columnas se llamen igual: TypeORM crea un enum por columna.
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_signature_type_enum" ADD VALUE IF NOT EXISTS 'BIOMETRIC'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_signature_type_enum" ADD VALUE IF NOT EXISTS 'BIOMETRIC'`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."biometric_signature_attempts_provider_enum" AS ENUM('DIDIT')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."biometric_signature_attempts_status_enum" AS ENUM(
        'PENDING',
        'IN_PROGRESS',
        'IN_REVIEW',
        'APPROVED',
        'DECLINED',
        'ABANDONED',
        'EXPIRED',
        'FAILED'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE "biometric_signature_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "collaborator_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "provider" "public"."biometric_signature_attempts_provider_enum" NOT NULL,
        "provider_session_id" character varying,
        "provider_workflow_id" character varying,
        "document_hash" character varying NOT NULL,
        "status" "public"."biometric_signature_attempts_status_enum" NOT NULL DEFAULT 'PENDING',
        "geolocation" jsonb NOT NULL,
        "provider_metadata" jsonb,
        "decision" jsonb,
        "failure_reason" text,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "approved_at" TIMESTAMP WITH TIME ZONE,
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
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // "El último intento de este firmante": lo que consulta la pantalla en cada sondeo.
    await queryRunner.query(
      `CREATE INDEX "IDX_biometric_signature_attempts_collaborator_created" ON "biometric_signature_attempts" ("collaborator_id", "created_at")`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_biometric_signature_attempts_active_collaborator" ON "biometric_signature_attempts" ("collaborator_id") WHERE "status" IN ('PENDING', 'IN_PROGRESS', 'IN_REVIEW')`,
    );
  }

  /**
   * Borra la tabla y sus tipos.
   *
   * `BIOMETRIC` se queda en los enums de tipo de firma: Postgres no elimina un valor sin recrear el
   * tipo entero, y para entonces podría haber colaboradores o documentos que lo usan. Una etiqueta
   * de más no afecta a ningún consumidor.
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
