import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `created_at` a `roles` y una constraint única `(organization_id, name)` (historia
 * "Reemplazar 'Permisos' por 'Roles y permisos' en organizaciones").
 *
 * `DEFAULT now()` rellena las dos filas existentes (ADMIN/MEMBER) sin un `UPDATE` aparte.
 *
 * La constraint única sólo protege en la práctica a los roles custom: Postgres trata cada NULL
 * como distinto en un UNIQUE multi-columna, así que `(NULL,'ADMIN')` y `(NULL,'MEMBER')` —los
 * roles de sistema, con `organization_id` nulo— nunca chocan entre sí ni con un futuro
 * `('org-x','ADMIN')` de una organización. No hace falta un índice parcial.
 */
export class AddCreatedAtAndUniqueNameToRoles1784300000054 implements MigrationInterface {
  name = 'AddCreatedAtAndUniqueNameToRoles1784300000054';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD CONSTRAINT "UQ_roles_organization_id_name" UNIQUE ("organization_id", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "UQ_roles_organization_id_name"`,
    );
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "created_at"`);
  }
}
