import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuración general de la API de integración por organización (`integration_settings`).
 *
 * - `integration_status_enum` (`ACTIVE`, `DISABLED`).
 * - Una fila como máximo por organización (`UQ_integration_settings_organization_id`), que se borra
 *   con ella (`ON DELETE CASCADE`). Es una restricción `UNIQUE` —Postgres la respalda con un índice
 *   único— y no un `CREATE UNIQUE INDEX` suelto, porque la relación `OneToOne` de la entidad exige
 *   una restricción y `schema:log` propondría crear otra con nombre generado.
 * - Backfill: toda organización que ya tiene alguna API key —activa o revocada— recibe su
 *   configuración `ACTIVE`, para que sus llamadas sigan funcionando al desplegar. Las demás no
 *   reciben fila: la crea `issueApiKey` con su primera llave. `ON CONFLICT DO NOTHING` hace el
 *   backfill repetible.
 */
export class CreateIntegrationSettings1784300000095 implements MigrationInterface {
  name = 'CreateIntegrationSettings1784300000095';

  /**
   * Crea el tipo, la tabla, la FK, la restricción única y el backfill.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `organizations` o `api_keys`, o si el tipo o la tabla
   *   ya existen.
   *
   * @example
   * ```ts
   * await new CreateIntegrationSettings1784300000095().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "integration_status_enum" AS ENUM ('ACTIVE', 'DISABLED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "integration_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "status" "integration_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_integration_settings_organization_id" UNIQUE ("organization_id"),
        CONSTRAINT "FK_integration_settings_organization_id" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "integration_settings" ("organization_id", "status")
      SELECT DISTINCT "organization_id", 'ACTIVE'::"integration_status_enum"
      FROM "api_keys"
      ON CONFLICT ("organization_id") DO NOTHING
    `);
  }

  /**
   * Borra la tabla y el tipo. Las organizaciones y sus llaves no se tocan.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla o el tipo no existen.
   *
   * @example
   * ```ts
   * await new CreateIntegrationSettings1784300000095().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "integration_settings"`);
    await queryRunner.query(`DROP TYPE "integration_status_enum"`);
  }
}
