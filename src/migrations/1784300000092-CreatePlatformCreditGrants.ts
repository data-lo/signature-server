import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recargas internas de créditos Enterprise
 * (`POST /api/v1/platform/organizations/:organizationId/credits`).
 *
 * `platform_credit_grants` es la constancia de cada recarga: quién la recibió, qué lote la acreditó
 * y con qué `Idempotency-Key` y folio se pidió. La fila y su `credit_lot` se escriben en la MISMA
 * transacción, así que uno no existe sin el otro.
 *
 * - Los índices únicos de la clave y del folio son los que impiden acreditar dos veces.
 * - Las referencias son `RESTRICT`, como las de `document_credit_consumptions`: un lote con dinero
 *   detrás no se borra llevándose de paso la constancia de por qué existía.
 *
 * Es incremental: no toca `credit_lots`, `billing_profiles` ni ninguna fila existente.
 */
export class CreatePlatformCreditGrants1784300000092 implements MigrationInterface {
  name = 'CreatePlatformCreditGrants1784300000092';

  /**
   * Crea la tabla de recargas y sus índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `organizations`, `billing_profiles` o `credit_lots`.
   *
   * @example
   * ```ts
   * await new CreatePlatformCreditGrants1784300000092().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "platform_credit_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "billing_profile_id" uuid NOT NULL,
        "credit_lot_id" uuid NOT NULL,
        "documents_granted" integer NOT NULL,
        "external_reference" character varying(255) NOT NULL,
        "idempotency_key" character varying(255) NOT NULL,
        "request_hash" character varying(64) NOT NULL,
        "notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_platform_credit_grants" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_platform_credit_grants_documents_granted" CHECK ("documents_granted" > 0),
        CONSTRAINT "FK_platform_credit_grants_organization_id"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_credit_grants_billing_profile_id"
          FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_platform_credit_grants_credit_lot_id"
          FOREIGN KEY ("credit_lot_id") REFERENCES "credit_lots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_platform_credit_grants_idempotency_key" ON "platform_credit_grants" ("idempotency_key")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_platform_credit_grants_external_reference" ON "platform_credit_grants" ("external_reference")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_platform_credit_grants_credit_lot_id" ON "platform_credit_grants" ("credit_lot_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_platform_credit_grants_organization_id" ON "platform_credit_grants" ("organization_id")`,
    );
  }

  /**
   * Borra la tabla de recargas. Se pierde la constancia, pero los lotes acreditados se quedan: el
   * saldo de los clientes no depende de esta tabla.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no existe.
   *
   * @example
   * ```ts
   * await new CreatePlatformCreditGrants1784300000092().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "platform_credit_grants"`);
  }
}
