import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trazabilidad e idempotencia de los documentos creados por la API de integración (historia
 * "Exponer API de integración para consultar y crear documentos mediante API Key").
 *
 * 1. `documents.created_via_api_key_id` (nullable): con qué API key se creó el documento. Junto
 *    con `created_by` permite decir "Creado por Juan Pérez vía Integración ERP". `SET NULL`: una
 *    llave sólo se borra con su organización, y el documento no debe impedirlo. Índice parcial,
 *    porque casi todos los documentos nacen en la plataforma y no tienen llave.
 * 2. `integration_idempotency_keys`: cada `Idempotency-Key` ya usado para crear un documento. La
 *    fila se inserta en la misma transacción que el documento y el crédito, así que
 *    `UQ_integration_idempotency_keys_organization_key` es lo que impide que un reintento cree un
 *    segundo documento o cobre otro crédito. La clave es por organización, no por llave.
 */
export class AddApiKeyOriginAndIntegrationIdempotency1784300000079 implements MigrationInterface {
  name = 'AddApiKeyOriginAndIntegrationIdempotency1784300000079';

  /**
   * Agrega la columna de origen y crea la tabla de claves de idempotencia.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `documents`, `api_keys` u `organizations`.
   *
   * @example
   * ```ts
   * await new AddApiKeyOriginAndIntegrationIdempotency1784300000079().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "created_via_api_key_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_created_via_api_key_id" FOREIGN KEY ("created_via_api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_created_via_api_key_id" ON "documents" ("created_via_api_key_id") WHERE "created_via_api_key_id" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "integration_idempotency_keys" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "api_key_id" uuid NOT NULL,
        "idempotency_key" character varying(255) NOT NULL,
        "request_fingerprint" character varying(64) NOT NULL,
        "document_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_idempotency_keys" PRIMARY KEY ("id"),
        CONSTRAINT "FK_integration_idempotency_keys_organization_id"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_integration_idempotency_keys_api_key_id"
          FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_integration_idempotency_keys_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_integration_idempotency_keys_organization_key" ON "integration_idempotency_keys" ("organization_id", "idempotency_key")`,
    );
  }

  /**
   * Borra la tabla de claves y la columna de origen.
   *
   * Pierde qué documentos se crearon por integración y las claves ya usadas: un reintento
   * posterior con una clave vieja volvería a crear el documento.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla o la columna ya no existen.
   *
   * @example
   * ```ts
   * await new AddApiKeyOriginAndIntegrationIdempotency1784300000079().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "integration_idempotency_keys"`);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_created_via_api_key_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_documents_created_via_api_key_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "created_via_api_key_id"`,
    );
  }
}
