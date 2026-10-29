import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 1 (ver plan de migración): agrega roles.visibility (int) tal
 * como lo pide el diagrama objetivo. Su significado de negocio todavía no está definido
 * por producto (¿bitmask de quién puede ver/asignar el rol? ¿un nivel/tier de
 * ordenamiento?) — se deja como columna con default 0 sin ninguna lógica de enforcement
 * todavía; se documenta aquí a propósito para que quede explícito que es un campo
 * "aterrizado, significado por definir", no una omisión.
 */
export class AddVisibilityToRoles1784300000001 implements MigrationInterface {
  name = 'AddVisibilityToRoles1784300000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "visibility" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "visibility"`);
  }
}
