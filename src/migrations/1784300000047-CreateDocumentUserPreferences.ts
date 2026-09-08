import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preferencias privadas de una persona sobre un documento. La primera es el archivado.
 *
 * **Por qué una tabla y no una columna en `documents`.** Un documento lo comparten su creador,
 * sus firmantes y sus observadores, así que una bandera en su fila sería una decisión de todos a
 * la vez: quien archivara un contrato ya firmado se lo escondería a quien todavía tiene que
 * firmarlo. Colgando la preferencia del PAR documento-usuario, cada quien ordena su bandeja sin
 * mover la de nadie. Por eso esta migración **no toca `documents`**.
 *
 * **`ON DELETE CASCADE` en las dos llaves.** La preferencia no es evidencia de nada —es cómo
 * alguien tenía ordenada su lista— así que no tiene por qué sobrevivir ni al documento ni al
 * usuario. Con `RESTRICT` o `SET NULL`, borrar una cuenta quedaría bloqueado por filas que a
 * nadie le importan, o dejaría preferencias huérfanas que ninguna consulta volvería a mirar.
 *
 * Esta migración crea el modelo y nada más: ningún endpoint, ninguna consulta y ninguna pantalla
 * lo usan todavía.
 *
 * **Numerada `047` y no `046`**, que es el siguiente libre en `development` (cuya última es la
 * `045`). El `046` lo reclama la rama del consumo de créditos, autónoma sobre `development` igual
 * que ésta: dos migraciones con el mismo número dejan su orden a merced del glob que las lista, y
 * la que se aplique segunda no tiene por qué ser la que uno cree. Las dos tocan tablas distintas,
 * así que el orden entre ellas da igual — lo que no da igual es que compartan número.
 *
 * Si al fusionar el `047` resultara ocupado, esta migración es de las baratas de renumerar: crea
 * una tabla nueva que nadie más referencia todavía, así que basta con cambiar el número en el
 * nombre del archivo, en la clase y en `name`.
 */
export class CreateDocumentUserPreferences1784300000047 implements MigrationInterface {
  name = 'CreateDocumentUserPreferences1784300000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `IF NOT EXISTS` en la tabla y en los índices: el entorno de desarrollo levanta el esquema
     * desde las entidades con `synchronize: true` Y ADEMÁS corre las migraciones (ver
     * `app.module.ts`), así que cuando ésta se ejecute la tabla puede estar ya creada por
     * TypeORM. Sin las guardas, el arranque moriría con "relation already exists" y el servidor
     * se quedaría reintentando la conexión en bucle.
     */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "document_user_preferences" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "archived_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_user_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "FK_document_user_preferences_document"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_document_user_preferences_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    /**
     * Una sola preferencia por par documento-usuario, garantizada por el motor.
     *
     * Sin ella, dos peticiones simultáneas —dos pestañas, un doble clic en "Archivar"—
     * insertarían dos filas y la lectura siguiente tendría que decidir cuál manda. Va como
     * `CONSTRAINT` y no como índice único suelto para que TypeORM la reconozca igual que el
     * `@Unique` de la entidad y no intente recrearla en cada `synchronize`.
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'UQ_document_user_preferences_document_user'
        ) THEN
          ALTER TABLE "document_user_preferences"
            ADD CONSTRAINT "UQ_document_user_preferences_document_user"
            UNIQUE ("document_id", "user_id");
        END IF;
      END $$;
    `);

    /**
     * La bandeja de una persona: sus documentos archivados, o los que no lo están. `user_id`
     * primero porque es la igualdad; `archived_at` después, porque es el filtro. Con un índice
     * sólo por usuario, Postgres tendría que leer todas sus filas para descartar las demás.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_document_user_preferences_user_archived"
        ON "document_user_preferences" ("user_id", "archived_at")
    `);

    /**
     * El camino inverso —todas las preferencias de un documento— y el que recorre el `CASCADE`
     * al borrar uno con muchas. Lo cubriría el índice de la restricción única, que empieza por la
     * misma columna, pero apoyarse en su forma ataría esta consulta a una restricción que podría
     * cambiar de columnas.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_document_user_preferences_document"
        ON "document_user_preferences" ("document_id")
    `);
  }

  /**
   * `DROP TABLE` se lleva por delante sus índices y restricciones, así que no hay que borrarlos
   * uno a uno. Revertir PIERDE las preferencias guardadas —qué tenía archivado cada quien— y es
   * aceptable: son datos de conveniencia, reconstruibles archivando de nuevo, y no hay dónde
   * conservarlos si la tabla desaparece.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "document_user_preferences"');
  }
}
