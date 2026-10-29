import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renombra `organizations.rfc` a `organizations.tax_id`.
 *
 * Es un `ALTER TABLE ... RENAME COLUMN`, no un par crear/copiar/borrar: Postgres renombra la
 * columna en el catálogo sin reescribir la tabla, así que **los identificadores fiscales ya
 * capturados se conservan por construcción** —no hay ventana en la que una organización quede sin
 * su valor—. La columna no tiene índices ni constraints propios (es un `varchar NULL`), así que no
 * queda nada más que ajustar.
 *
 * Mismo criterio que `StandardizeCollaboratorFields1784300000059` con `collaborators.tax_id`: el
 * nombre técnico deja de dar por hecho que la organización tributa en México, aunque hoy guarde un
 * RFC y la etiqueta que ve el usuario siga diciendo "RFC". El RFC de `personal_information` y el
 * que se extrae del certificado del SAT no se tocan: ésos sí son, por definición, un RFC.
 */
export class RenameOrganizationRfcToTaxId1784300000067 implements MigrationInterface {
  name = 'RenameOrganizationRfcToTaxId1784300000067';

  /**
   * Renombra `rfc` a `tax_id` en `organizations`, conservando los valores.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si `organizations.rfc` no existe — señal de que la base no viene
   * del esquema que dejó `MergeAccountAndOrganization`, y que hay que revisarla antes de seguir en
   * vez de dejarla a medio migrar.
   *
   * @example
   * ```ts
   * await new RenameOrganizationRfcToTaxId1784300000067().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" RENAME COLUMN "rfc" TO "tax_id"`,
    );
  }

  /**
   * Devuelve la columna a su nombre anterior; los valores vuelven intactos, por lo mismo que en
   * `up`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si `organizations.tax_id` ya no existe con ese nombre.
   *
   * @example
   * ```ts
   * await new RenameOrganizationRfcToTaxId1784300000067().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" RENAME COLUMN "tax_id" TO "rfc"`,
    );
  }
}
