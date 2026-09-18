import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elimina `roles.visibility` del modelo de permisos.
 *
 * La agregó `AddVisibilityToRoles` como campo "aterrizado, significado por definir" del diagrama
 * ER-V2, con default 0 y sin enforcement. Ese significado nunca se definió: ningún servicio,
 * endpoint, DTO, seed ni pantalla la escribe o la lee, y quién puede ver o asignar un rol lo
 * deciden `is_system_role`, `organization_id` y el RBAC de `role_permissions`.
 *
 * No tiene índices ni constraints propios, así que basta con quitar la columna. `IF EXISTS` para
 * que corra igual sobre una base donde ya no esté.
 */
export class DropVisibilityFromRoles1784300000058 implements MigrationInterface {
  name = 'DropVisibilityFromRoles1784300000058';

  /**
   * Quita la columna `roles.visibility`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new DropVisibilityFromRoles1784300000058().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" DROP COLUMN IF EXISTS "visibility"`,
    );
  }

  /**
   * Vuelve a crear la columna con su definición original; todas las filas quedan en 0, que es el
   * único valor que llegó a tener.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new DropVisibilityFromRoles1784300000058().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" ADD "visibility" integer NOT NULL DEFAULT 0`,
    );
  }
}
