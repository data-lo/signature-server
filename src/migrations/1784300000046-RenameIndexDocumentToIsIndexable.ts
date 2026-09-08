import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `documents.index_document` pasa a `documents.is_indexable`, con `DEFAULT true`.
 *
 * **El renombre no es cosmético: invierte el significado por omisión.** La columna nació en
 * `AddDocumentAdditiveColumns1784300000002` declarada como no-op —"hasta que se conecten flujos
 * futuros (... indexado ...)"— con `DEFAULT false`, y desde entonces ningún código la escribió
 * nunca. A partir de esta historia sí decide algo: si el documento entra a Búsqueda Inteligente.
 * La regla de producto es que TODO documento sea indexable salvo que su autor diga lo contrario,
 * así que el default se invierte junto con el nombre.
 *
 * **Por qué las filas existentes se ponen en `true` en vez de conservar su `false`.** Ese `false`
 * no es la decisión de nadie: es el valor con el que se creó una columna que jamás se escribió.
 * Conservarlo dejaría a TODO el histórico permanentemente fuera de Búsqueda Inteligente por un
 * default muerto, y sin ninguna pantalla desde la cual corregirlo —la decisión sólo se captura al
 * CREAR un documento—. El `UPDATE` es, en la práctica, el backfill de "los documentos que no
 * tienen valor quedan indexables", porque ninguno lo tiene.
 *
 * Si en el futuro la columna sí guarda decisiones reales, una migración como ésta ya no podría
 * pisarlas: el criterio de arriba vale porque hoy consta que nadie la escribió.
 *
 * **`is_indexable` y no `indexable` ni `index_document`.** El prefijo `is_` es el que ya usa el
 * resto de la tabla para sus banderas (`is_sequential`), y el nombre viejo se leía como un verbo
 * —"indexa este documento"— cuando lo que guarda es una propiedad del documento.
 */
export class RenameIndexDocumentToIsIndexable1784300000046 implements MigrationInterface {
  name = 'RenameIndexDocumentToIsIndexable1784300000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * El renombre va condicionado a que la columna vieja exista, para que la migración corra en
     * una base de desarrollo que ya levantó el esquema desde las entidades (donde la columna ya
     * se llama `is_indexable`) sin reventar con "column does not exist".
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'documents' AND column_name = 'index_document'
        ) THEN
          ALTER TABLE "documents" RENAME COLUMN "index_document" TO "is_indexable";
        END IF;
      END $$;
    `);

    // La columna tiene que existir aunque no hubiera ninguna de las dos: una base creada desde
    // cero por una versión anterior de las entidades podría no traerla.
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "is_indexable" boolean
    `);

    /**
     * El orden importa: primero se llenan los valores y sólo después se impone `NOT NULL`. Al
     * revés, una fila nula haría fallar la restricción antes de que el `UPDATE` la arregle.
     *
     * Se ponen en `true` TODAS las filas, no sólo las nulas: ver el docblock de arriba — el
     * `false` que traen no lo eligió nadie.
     */
    await queryRunner.query(`UPDATE "documents" SET "is_indexable" = true`);

    await queryRunner.query(`
      ALTER TABLE "documents"
        ALTER COLUMN "is_indexable" SET DEFAULT true,
        ALTER COLUMN "is_indexable" SET NOT NULL
    `);
  }

  /**
   * Deshace el renombre y el default, y devuelve la columna a su estado de no-op: `false` en
   * todas las filas, que es como estaba antes de esta migración.
   *
   * **La reversión PIERDE las decisiones capturadas** entre el `up` y el `down` — quien haya
   * elegido "No agregar a Búsqueda Inteligente" queda indistinguible de quien no eligió nada. No
   * hay forma de evitarlo: el esquema anterior no tiene dónde guardar esa diferencia. Es
   * aceptable porque el `down` existe para retroceder un despliegue recién hecho, no para
   * convivir semanas con la columna vieja.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'documents' AND column_name = 'is_indexable'
        ) THEN
          ALTER TABLE "documents" RENAME COLUMN "is_indexable" TO "index_document";
        END IF;
      END $$;
    `);

    await queryRunner.query(`UPDATE "documents" SET "index_document" = false`);

    await queryRunner.query(`
      ALTER TABLE "documents"
        ALTER COLUMN "index_document" SET DEFAULT false,
        ALTER COLUMN "index_document" SET NOT NULL
    `);
  }
}
