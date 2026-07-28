import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 4 (ver plan de migración): agrega coordenadas de firma por
 * colaborador, reemplazando el ancla única "Document.signatureCoordinates" + apilado
 * automático por índice como único mecanismo. `collaborators.simple_signature_id` es
 * opcional: si un colaborador no tiene coordenadas explícitas, `finalizeSignedDocument`
 * cae al apilado automático existente (comportamiento actual, sin cambios para quien no
 * adopte coordenadas por colaborador).
 *
 * `collaborators.signature_type_id` (columna genérica sin FK agregada en la Fase 3, como
 * placeholder polimórfico) se reemplaza aquí por el par real `simple_signature_id`
 * (con FK, ya que simple_signatures existe) + `fiel_signature_id` (sin FK todavía —
 * fiel_signatures se crea en la Fase 8).
 */
export class CreateSimpleSignatures1784300000004 implements MigrationInterface {
  name = 'CreateSimpleSignatures1784300000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "simple_signatures" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "verification_code" uuid,
        "signature_coordinates" jsonb NOT NULL,
        CONSTRAINT "PK_simple_signatures" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "collaborators"
        DROP COLUMN "signature_type_id",
        ADD "simple_signature_id" uuid,
        ADD "fiel_signature_id" uuid
    `);

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_simple_signature_id" FOREIGN KEY ("simple_signature_id") REFERENCES "simple_signatures"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "FK_collaborators_simple_signature_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "collaborators"
        DROP COLUMN "simple_signature_id",
        DROP COLUMN "fiel_signature_id",
        ADD "signature_type_id" uuid
    `);
    await queryRunner.query(`DROP TABLE "simple_signatures"`);
  }
}
