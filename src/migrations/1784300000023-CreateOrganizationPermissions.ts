import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia [STORY] Configuración de catálogo de permisos y asignación por usuario: catálogo
 * administrativo de permisos por organización (`organization_permissions`) más la asignación
 * directa a un miembro (`account_permissions`). Deliberadamente separado del motor de RBAC ya
 * existente (`roles`/`resources`/`actions`/`permissions`/`role_permissions`, ver
 * CreateRolesModule) — este catálogo no participa en ninguna autorización real, es solo una
 * lista administrada por el ADMIN de la organización y asignable como lista a un miembro.
 */
export class CreateOrganizationPermissions1784300000023
  implements MigrationInterface
{
  name = 'CreateOrganizationPermissions1784300000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organization_permissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_organization_permissions_organization_id_name" UNIQUE ("organization_id", "name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "account_permissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "organization_permission_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_account_permissions_account_id_organization_permission_id" UNIQUE ("account_id", "organization_permission_id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "organization_permissions" ADD CONSTRAINT "FK_organization_permissions_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_permissions" ADD CONSTRAINT "FK_account_permissions_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_permissions" ADD CONSTRAINT "FK_account_permissions_organization_permission_id" FOREIGN KEY ("organization_permission_id") REFERENCES "organization_permissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_permissions" DROP CONSTRAINT "FK_account_permissions_organization_permission_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_permissions" DROP CONSTRAINT "FK_account_permissions_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_permissions" DROP CONSTRAINT "FK_organization_permissions_organization_id"`,
    );
    await queryRunner.query(`DROP TABLE "account_permissions"`);
    await queryRunner.query(`DROP TABLE "organization_permissions"`);
  }
}
