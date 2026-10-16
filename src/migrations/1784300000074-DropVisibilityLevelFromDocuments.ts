import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elimina `documents.visibility_level` (historia "Eliminar campo visibility_level de documentos").
 *
 * Es la gemela de la columna que `StandardizeCollaboratorFields` ya quitó de `collaborators`, y se
 * va por lo mismo: `AddDocumentAdditiveColumns` la creó como campo "aterrizado, significado por
 * definir" (`integer NOT NULL DEFAULT 0`) y ese significado nunca se definió. Ningún servicio,
 * endpoint, DTO ni pantalla la escribe o la lee, así que sólo ha tenido el `0` por defecto; quién
 * ve un documento lo deciden la cuenta, la organización y el flujo de firma.
 */
export class DropVisibilityLevelFromDocuments1784300000074 implements MigrationInterface {
  name = 'DropVisibilityLevelFromDocuments1784300000074';

  /**
   * Elimina la columna `visibility_level` de `documents`.
   *
   * `IF EXISTS` deja la migración segura en una base que ya no la tenga.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla `documents` no existe.
   *
   * @example
   * ```ts
   * await new DropVisibilityLevelFromDocuments1784300000074().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "visibility_level"`,
    );
  }

  /**
   * Devuelve la columna con su definición original, `integer NOT NULL DEFAULT 0`.
   *
   * Las filas existentes reaparecen con `0`, que es el único valor que llegó a tener, así que la
   * reversión no pierde nada.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla `documents` no existe.
   *
   * @example
   * ```ts
   * await new DropVisibilityLevelFromDocuments1784300000074().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "visibility_level" integer NOT NULL DEFAULT 0`,
    );
  }
}
