import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Directorio de contactos por cuenta activa (historia "Implementar directorio de contactos por
 * cuenta activa").
 *
 * 1. `directories`: un directorio por dueño. El dueño es la cuenta personal
 *    (`personal_account_id`) o la organización (`organization_id`), nunca la membresía de un
 *    miembro: eso daría un directorio por usuario dentro de la misma organización.
 * 2. `directory_contacts`: los contactos de cada directorio, con quién los creó y quién los
 *    modificó por última vez (`accounts`, la membresía), y la cuenta personal de la plataforma que
 *    les corresponde cuando la tienen.
 *
 * Restricciones:
 * - `CHK_directories_single_owner`: exactamente uno de los dos dueños.
 * - `UQ_directories_personal_account_id` / `UQ_directories_organization_id`: a lo sumo un
 *   directorio por dueño. Postgres no compara NULL en un `UNIQUE`, así que la columna vacía de
 *   cada fila no choca con las demás.
 * - `UQ_directory_contacts_directory_email`: un correo normalizado por directorio. También sirve
 *   de índice para `directory_id` (es su primera columna).
 * - `ON DELETE CASCADE` de `directory_contacts` a `directories` y de `directories` a su dueño;
 *   `SET NULL` en `linked_personal_account_id`, porque el contacto sobrevive como externo.
 *   `created_by`/`updated_by` quedan en `NO ACTION`: se comprueba al final de la sentencia, así
 *   que borrar una organización (que arrastra a la vez sus cuentas y su directorio) no tropieza.
 */
export class CreateDirectories1784300000070 implements MigrationInterface {
  name = 'CreateDirectories1784300000070';

  /**
   * Crea `directories` y `directory_contacts` con sus claves, restricciones e índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las tablas ya existen o no existen `accounts`/`organizations`.
   *
   * @example
   * ```ts
   * await new CreateDirectories1784300000070().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "directories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "personal_account_id" uuid,
        "organization_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_directories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_directories_personal_account_id" UNIQUE ("personal_account_id"),
        CONSTRAINT "UQ_directories_organization_id" UNIQUE ("organization_id"),
        CONSTRAINT "CHK_directories_single_owner" CHECK (
          ("personal_account_id" IS NOT NULL AND "organization_id" IS NULL)
          OR ("personal_account_id" IS NULL AND "organization_id" IS NOT NULL)
        ),
        CONSTRAINT "FK_directories_personal_account_id"
          FOREIGN KEY ("personal_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_directories_organization_id"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "directory_contacts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "directory_id" uuid NOT NULL,
        "email_normalized" character varying NOT NULL,
        "first_name" character varying NOT NULL,
        "last_name" character varying NOT NULL,
        "linked_personal_account_id" uuid,
        "created_by_account_id" uuid NOT NULL,
        "updated_by_account_id" uuid NOT NULL,
        "archived_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_directory_contacts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_directory_contacts_directory_email" UNIQUE ("directory_id", "email_normalized"),
        CONSTRAINT "FK_directory_contacts_directory_id"
          FOREIGN KEY ("directory_id") REFERENCES "directories"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_directory_contacts_linked_personal_account_id"
          FOREIGN KEY ("linked_personal_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_directory_contacts_created_by_account_id"
          FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id"),
        CONSTRAINT "FK_directory_contacts_updated_by_account_id"
          FOREIGN KEY ("updated_by_account_id") REFERENCES "accounts"("id")
      )
    `);

    // Lo recorre el `SET NULL` al borrar una cuenta, y la futura consulta "¿en qué directorios
    // aparece esta cuenta?".
    await queryRunner.query(
      `CREATE INDEX "IDX_directory_contacts_linked_personal_account_id" ON "directory_contacts" ("linked_personal_account_id")`,
    );
  }

  /**
   * Borra las dos tablas; los contactos primero, porque dependen del directorio.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las tablas ya no existen.
   *
   * @example
   * ```ts
   * await new CreateDirectories1784300000070().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "directory_contacts"`);
    await queryRunner.query(`DROP TABLE "directories"`);
  }
}
