import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia [STORY] Frontend: Carga de Documentos y Configuración de Firmantes — el payload
 * unificado que pide esa historia necesita dos cosas que no existían:
 *  - documents.requires_approval: checkbox "Requiere aprobación" a nivel documento.
 *  - collaborators.first_name/last_name/rfc: el nuevo formulario captura nombre/apellido/RFC
 *    del colaborador al invitarlo (antes solo se guardaba email para invitados sin cuenta).
 * Todas nullable/con default — ningún caller existente se ve afectado.
 */
export class AddApprovalAndCollaboratorNames1784300000014 implements MigrationInterface {
  name = 'AddApprovalAndCollaboratorNames1784300000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "requires_approval" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`
      ALTER TABLE "collaborators"
        ADD "first_name" character varying,
        ADD "last_name" character varying,
        ADD "rfc" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "collaborators"
        DROP COLUMN "first_name",
        DROP COLUMN "last_name",
        DROP COLUMN "rfc"
    `);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "requires_approval"`,
    );
  }
}
