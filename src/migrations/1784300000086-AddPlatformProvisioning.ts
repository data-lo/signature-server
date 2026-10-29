import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aprovisionamiento interno de cuentas provisionales Enterprise
 * (`POST /api/v1/internal/organizations/provision`).
 *
 * 1. `api_keys.created_by_account_id` pasa a ser nullable: una llave emitida por la plataforma
 *    (el aprovisionamiento interno) no la emite ninguna membresía. Las que emite un administrador
 *    desde `/organizations/:id/api-keys` siguen llevando su membresía.
 * 2. `platform_provisioning_requests`: cada `Idempotency-Key` ya usado para aprovisionar, con lo
 *    que creó. La fila se escribe en la MISMA transacción que la organización, el perfil, los
 *    créditos y la llave, así que existe si y sólo si el aprovisionamiento se confirmó. Un
 *    reintento con la misma clave la encuentra y responde con lo ya creado, sin duplicar nada.
 *    Todas las referencias son `CASCADE` desde la organización: borrarla libera la clave.
 */
export class AddPlatformProvisioning1784300000086 implements MigrationInterface {
  name = 'AddPlatformProvisioning1784300000086';

  /**
   * Vuelve nullable al emisor de la llave y crea la tabla de claves de aprovisionamiento.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `api_keys`, `organizations`, `users`, `accounts` o
   *   `billing_profiles`.
   *
   * @example
   * ```ts
   * await new AddPlatformProvisioning1784300000086().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" ALTER COLUMN "created_by_account_id" DROP NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "platform_provisioning_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "idempotency_key" character varying(255) NOT NULL,
        "request_hash" character varying(64) NOT NULL,
        "organization_id" uuid NOT NULL,
        "organization_account_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "owner_account_id" uuid NOT NULL,
        "billing_profile_id" uuid NOT NULL,
        "api_key_id" uuid NOT NULL,
        "documents_granted" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_platform_provisioning_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_platform_provisioning_requests_documents_granted" CHECK ("documents_granted" > 0),
        CONSTRAINT "FK_platform_provisioning_requests_organization_id"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_provisioning_requests_organization_account_id"
          FOREIGN KEY ("organization_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_provisioning_requests_owner_user_id"
          FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_provisioning_requests_owner_account_id"
          FOREIGN KEY ("owner_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_provisioning_requests_billing_profile_id"
          FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_provisioning_requests_api_key_id"
          FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_platform_provisioning_requests_idempotency_key" ON "platform_provisioning_requests" ("idempotency_key")`,
    );
  }

  /**
   * Borra la tabla de claves y vuelve obligatorio al emisor de la llave.
   *
   * Se niega si hay llaves emitidas por la plataforma: volver a `NOT NULL` fallaría a mitad de la
   * migración, y borrarlas en silencio dejaría sin acceso a integraciones que las están usando.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si quedan API keys sin `created_by_account_id`.
   *
   * @example
   * ```ts
   * await new AddPlatformProvisioning1784300000086().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ platformKeys }] = await queryRunner.query(
      `SELECT count(*)::int AS "platformKeys" FROM "api_keys" WHERE "created_by_account_id" IS NULL`,
    );
    if (platformKeys > 0) {
      throw new Error(
        `No se puede revertir AddPlatformProvisioning: hay ${platformKeys} API key(s) emitidas por la plataforma (sin created_by_account_id). Revócalas y bórralas antes.`,
      );
    }

    await queryRunner.query(`DROP TABLE "platform_provisioning_requests"`);
    await queryRunner.query(
      `ALTER TABLE "api_keys" ALTER COLUMN "created_by_account_id" SET NOT NULL`,
    );
  }
}
