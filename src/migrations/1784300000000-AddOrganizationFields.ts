import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 1 (ver plan de migración): agrega a organization_details los
 * campos de perfil de organización que ya especifica el diagrama objetivo (isActive,
 * address, rfc, domainAllowed, phoneNumber, indexDocuments) y que hoy no existen —
 * OrganizationDetailEntity solo tenía accountId+name. Cambio puramente aditivo: todas
 * las columnas son nullable o con default, sin backfill necesario más allá del default,
 * y organization_details no tiene referencias fuera de src/account/ (confirmado por
 * grep), así que no hay ningún caller externo que romper.
 */
export class AddOrganizationFields1784300000000 implements MigrationInterface {
  name = 'AddOrganizationFields1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organization_details"
        ADD "is_active" boolean NOT NULL DEFAULT true,
        ADD "address" text,
        ADD "rfc" character varying,
        ADD "domain_allowed" character varying,
        ADD "phone_number" character varying,
        ADD "index_documents" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organization_details"
        DROP COLUMN "is_active",
        DROP COLUMN "address",
        DROP COLUMN "rfc",
        DROP COLUMN "domain_allowed",
        DROP COLUMN "phone_number",
        DROP COLUMN "index_documents"
    `);
  }
}
