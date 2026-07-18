import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia [STORY] Eventos Kafka, Email (SendGrid) y Miembros (/join): tabla de invitaciones
 * pendientes a una organización. Antes, `POST /api/v1/organizations/invite` (ver historia
 * "Módulo de Invitación de Miembros") validaba y respondía éxito sin persistir nada — esta
 * tabla, junto con el token único que lleva el enlace del correo (`/join?token=...`), es lo
 * que conecta esa invitación con una aceptación real (crear la membresía en `accounts`).
 */
export class CreateOrganizationInvitations1784300000009
  implements MigrationInterface
{
  name = 'CreateOrganizationInvitations1784300000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."organization_invitations_status_enum" AS ENUM('PENDING', 'ACCEPTED', 'EXPIRED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "organization_invitations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        "invited_by" uuid NOT NULL,
        "email" character varying NOT NULL,
        "token" character varying NOT NULL,
        "status" "public"."organization_invitations_status_enum" NOT NULL DEFAULT 'PENDING',
        "expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_organization_invitations_token" UNIQUE ("token")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "FK_organization_invitations_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "FK_organization_invitations_role_id" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "FK_organization_invitations_invited_by" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "FK_organization_invitations_invited_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "FK_organization_invitations_role_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "FK_organization_invitations_organization_id"`,
    );
    await queryRunner.query(`DROP TABLE "organization_invitations"`);
    await queryRunner.query(
      `DROP TYPE "public"."organization_invitations_status_enum"`,
    );
  }
}
