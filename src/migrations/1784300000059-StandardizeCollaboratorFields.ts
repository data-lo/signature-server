import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Estandariza los nombres de campo de `collaborators`: `geo_loc` pasa a `geolocation`, `rfc` pasa
 * a `tax_id` y `visibility_level` desaparece.
 *
 * Los dos renombres son `ALTER TABLE ... RENAME COLUMN`, no un par crear/copiar/borrar: Postgres
 * renombra la columna en el catálogo sin reescribir la tabla, así que **los datos existentes se
 * conservan por construcción** —no hay ventana en la que una fila quede sin su valor— y los
 * índices, defaults y constraints que colgaran de la columna la siguen. Ninguna de las dos tiene
 * hoy índices ni constraints propios (sólo son `jsonb NULL` y `varchar NULL`), así que no queda
 * nada más que ajustar.
 *
 * Por qué cada uno:
 *
 * - **`geolocation`** es el nombre que ya usa el resto del sistema de punta a punta: el
 *   `GeolocationDto` con el que el firmante manda su ubicación, el `geolocation` de la cadena de
 *   auditoría (`audit.service.ts`) y el nodo `geoLocation` del XML. `geo_loc` era el único sitio
 *   con la abreviatura, heredada de la Fase 3 del plan ER-V2.
 * - **`tax_id`** separa el nombre del campo de un régimen fiscal concreto. La columna guarda hoy
 *   el RFC mexicano del espectador —y la etiqueta que ve el usuario sigue diciendo "RFC", porque
 *   eso es lo que captura—, pero el modelo deja de dar por hecho que todo colaborador tributa en
 *   México. No se toca el RFC de `personal_information`, `organizations` ni el que se extrae del
 *   certificado del SAT: ese sí es, por definición, un RFC.
 * - **`visibility_level`** se va por lo mismo que `roles.visibility` en `DropVisibilityFromRoles`:
 *   la creó la migración de la Fase 3 como campo "aterrizado, significado por definir" y ese
 *   significado nunca se definió. Ningún servicio, endpoint, DTO ni pantalla la escribe o la lee,
 *   y quién ve un documento lo deciden el tipo de colaborador y el flujo de firma. Su gemela
 *   `documents.visibility_level` queda intacta: esta historia sólo alcanza a `collaborators`.
 */
export class StandardizeCollaboratorFields1784300000059 implements MigrationInterface {
  name = 'StandardizeCollaboratorFields1784300000059';

  /**
   * Renombra `geo_loc` y `rfc`, y elimina `visibility_level`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si alguna de las dos columnas a renombrar no existe — señal de que
   * la base no viene del esquema que dejó `CreateCollaboratorsFromDocumentParticipants`, y que hay
   * que revisarla antes de seguir en vez de dejarla a medio migrar.
   *
   * @example
   * ```ts
   * await new StandardizeCollaboratorFields1784300000059().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "geo_loc" TO "geolocation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "rfc" TO "tax_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN IF EXISTS "visibility_level"`,
    );
  }

  /**
   * Deshace los renombres y devuelve la columna eliminada con su definición original.
   *
   * Los valores de `geolocation` y `tax_id` vuelven intactos, por lo mismo que en `up`. Lo que no
   * vuelve es el contenido de `visibility_level`: la columna reaparece entera en NULL, que es el
   * único valor que llegó a tener en toda su vida.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las columnas renombradas ya no existen con su nombre nuevo.
   *
   * @example
   * ```ts
   * await new StandardizeCollaboratorFields1784300000059().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD COLUMN IF NOT EXISTS "visibility_level" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "tax_id" TO "rfc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" RENAME COLUMN "geolocation" TO "geo_loc"`,
    );
  }
}
