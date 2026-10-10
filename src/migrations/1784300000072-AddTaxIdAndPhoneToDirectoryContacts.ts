import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `tax_id` y `phone` a `directory_contacts` (historia "Implementar los endpoints NestJS
 * necesarios para consultar y administrar los contactos del directorio").
 *
 * El alta de contactos pide RFC y teléfono, y el listado busca también por RFC; `CreateDirectories`
 * no los trajo porque esa historia sólo modelaba la estructura. Los dos son opcionales: un contacto
 * externo puede no tener ninguno de los dos.
 *
 * Sin índice para `tax_id`: la búsqueda es por subcadena (`ILIKE '%…%'`), que un índice B-tree no
 * acelera, y siempre va acotada al `directory_id`, que ya cubre `UQ_directory_contacts_directory_email`.
 */
export class AddTaxIdAndPhoneToDirectoryContacts1784300000072 implements MigrationInterface {
  name = 'AddTaxIdAndPhoneToDirectoryContacts1784300000072';

  /**
   * Agrega las columnas `tax_id` y `phone`, ambas nulables.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si `directory_contacts` no existe.
   *
   * @example
   * ```ts
   * await new AddTaxIdAndPhoneToDirectoryContacts1784300000072().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "directory_contacts"
        ADD COLUMN "tax_id" character varying,
        ADD COLUMN "phone" character varying
    `);
  }

  /**
   * Quita las dos columnas, con los datos que tuvieran.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las columnas ya no existen.
   *
   * @example
   * ```ts
   * await new AddTaxIdAndPhoneToDirectoryContacts1784300000072().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "directory_contacts"
        DROP COLUMN "phone",
        DROP COLUMN "tax_id"
    `);
  }
}
