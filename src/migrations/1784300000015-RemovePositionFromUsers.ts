import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El campo "Puesto" deja de ser parte de la información requerida/almacenada
 * para UserEntity (nueva especificación de negocio) — se elimina la columna
 * en vez de solo dejar de usarla, para no arrastrar una columna NOT NULL
 * huérfana que además obligaría a seguir enviando un valor dummy en cada insert.
 */
export class RemovePositionFromUsers1784300000015 implements MigrationInterface {
  name = 'RemovePositionFromUsers1784300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "position"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "position" character varying NOT NULL DEFAULT ''`,
    );
  }
}
