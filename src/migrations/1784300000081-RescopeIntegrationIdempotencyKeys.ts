import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajusta `integration_idempotency_keys` (de `AddApiKeyOriginAndIntegrationIdempotency`) al ciclo
 * reservar → completar de la historia "Crear documentos desde API de integración con creador
 * aprovisionado y URL pública".
 *
 * 1. La unicidad pasa de `(organization_id, idempotency_key)` a `(api_key_id, idempotency_key)`, y
 *    `organization_id` se elimina: la organización ya se deduce de la llave.
 * 2. `request_fingerprint` se renombra a `request_hash` (mismo contenido, SHA-256 del archivo y
 *    del payload).
 * 3. `status` (`PROCESSING` | `COMPLETED`): la clave se reserva antes de subir el archivo y se
 *    completa en la transacción del documento. Las filas existentes ya eran documentos creados:
 *    quedan `COMPLETED`.
 * 4. `document_id` admite `NULL` mientras la clave está `PROCESSING`;
 *    `CHK_integration_idempotency_keys_completed_document` lo exige en `COMPLETED`.
 * 5. `expires_at`: fin de la reserva o de la retención. Las filas existentes reciben 24 horas desde
 *    su creación, la misma retención que aplica ahora el caso de uso.
 */
export class RescopeIntegrationIdempotencyKeys1784300000081 implements MigrationInterface {
  name = 'RescopeIntegrationIdempotencyKeys1784300000081';

  /**
   * Reajusta la tabla al ciclo reservar → completar con unicidad por llave.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no tiene la forma de la migración 079, o si dos filas
   *   de la misma llave comparten clave (no puede pasar: antes la unicidad era más estricta).
   *
   * @example
   * ```ts
   * await new RescopeIntegrationIdempotencyKeys1784300000081().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_integration_idempotency_keys_organization_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" DROP CONSTRAINT "FK_integration_idempotency_keys_organization_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" DROP COLUMN "organization_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" RENAME COLUMN "request_fingerprint" TO "request_hash"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."integration_idempotency_keys_status_enum" AS ENUM('PROCESSING', 'COMPLETED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ADD "status" "public"."integration_idempotency_keys_status_enum" NOT NULL DEFAULT 'COMPLETED'`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ADD "expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "integration_idempotency_keys" SET "expires_at" = "created_at" + interval '24 hours'`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ALTER COLUMN "expires_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ALTER COLUMN "document_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ADD CONSTRAINT "CHK_integration_idempotency_keys_completed_document" CHECK ("status" <> 'COMPLETED' OR "document_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_integration_idempotency_keys_api_key_key" ON "integration_idempotency_keys" ("api_key_id", "idempotency_key")`,
    );
  }

  /**
   * Vuelve a la forma de la migración 079.
   *
   * Las reservas `PROCESSING` se descartan (no tienen documento) y `organization_id` se reconstruye
   * desde la llave de cada fila.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si dos llaves de una misma organización usaron la misma clave: con
   *   la unicidad por organización de la 079 no caben juntas.
   *
   * @example
   * ```ts
   * await new RescopeIntegrationIdempotencyKeys1784300000081().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_integration_idempotency_keys_api_key_key"`,
    );
    await queryRunner.query(
      `DELETE FROM "integration_idempotency_keys" WHERE "status" = 'PROCESSING'`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" DROP CONSTRAINT "CHK_integration_idempotency_keys_completed_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ALTER COLUMN "document_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" DROP COLUMN "expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" DROP COLUMN "status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."integration_idempotency_keys_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" RENAME COLUMN "request_hash" TO "request_fingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ADD "organization_id" uuid`,
    );
    await queryRunner.query(`
      UPDATE "integration_idempotency_keys" "key"
      SET "organization_id" = "apiKey"."organization_id"
      FROM "api_keys" "apiKey"
      WHERE "apiKey"."id" = "key"."api_key_id"
    `);
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ALTER COLUMN "organization_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_idempotency_keys" ADD CONSTRAINT "FK_integration_idempotency_keys_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_integration_idempotency_keys_organization_key" ON "integration_idempotency_keys" ("organization_id", "idempotency_key")`,
    );
  }
}
