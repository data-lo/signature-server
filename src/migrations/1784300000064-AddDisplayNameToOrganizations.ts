import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Le da a `organizations` la columna `display_name`: el nombre corto con el que la organización
 * se presenta en la interfaz, separado de `name`, que es la razón social.
 *
 * El formulario de alta pide los dos desde siempre —"Nombre de visualización" y "Razón social"—
 * pero sólo había una columna donde guardarlos, así que el alta escribía la razón social y tiraba
 * el otro. De ahí que el selector de cuentas rotulara cada organización con su nombre legal
 * completo.
 *
 * **Las organizaciones existentes reciben `display_name = name`**, es decir su razón social. No es
 * un relleno cualquiera: es exactamente el texto que sus miembros ya venían viendo en el selector,
 * así que nadie estrena esta columna con un nombre distinto al que tenía ayer. Quien quiera el
 * nombre corto lo pone desde el perfil de la organización (`PATCH /account/:id`).
 *
 * Se agrega en tres pasos —nullable, relleno, NOT NULL— porque una tabla con filas no admite una
 * columna obligatoria sin valor por defecto. Un `DEFAULT` permanente sería peor: dejaría pasar
 * organizaciones nuevas sin nombre visible, que es justo lo que la columna viene a impedir.
 */
export class AddDisplayNameToOrganizations1784300000064 implements MigrationInterface {
  name = 'AddDisplayNameToOrganizations1784300000064';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "display_name" character varying`,
    );

    await queryRunner.query(
      `UPDATE "organizations" SET "display_name" = "name" WHERE "display_name" IS NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "organizations" ALTER COLUMN "display_name" SET NOT NULL`,
    );
  }

  /**
   * Devuelve la tabla a una sola columna de nombre. Es una reversión CON PÉRDIDA y no puede ser
   * otra cosa: el nombre corto no vive en ningún otro sitio, así que al soltar la columna se
   * pierde, y las organizaciones vuelven a presentarse con su razón social.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "display_name"`,
    );
  }
}
