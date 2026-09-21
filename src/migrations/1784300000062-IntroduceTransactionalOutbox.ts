import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convierte `events` en una outbox transaccional y agrega `processed_events`, la tabla con la que
 * los consumidores se vuelven idempotentes (historia "Implementar flujo de aprobación previo al
 * proceso de firma").
 *
 * **Por qué `events` y no una tabla nueva.** Ya guarda exactamente lo que una outbox necesita —qué
 * pasó, sobre qué, quién lo hizo y cuándo— y ya es la traza de lo que se publica en Kafka. Lo que
 * le faltaba no era estructura sino garantía: hasta ahora la fila se escribía DESPUÉS de publicar
 * y fuera de la transacción del cambio de estado, así que un fallo entre una cosa y la otra dejaba
 * el documento movido y el evento sin publicar, o publicado y sin registrar. Con `published_at`,
 * la fila se escribe DENTRO de la transacción que cambia el estado y la publicación se convierte
 * en un paso posterior y reintentable.
 *
 * Las columnas nuevas:
 *
 * - **`published_at`** es el estado de la outbox: `NULL` significa "escrito pero todavía no
 *   publicado". El índice parcial sólo cubre esas filas —las pendientes son siempre pocas y las
 *   publicadas crecen sin límite—, así que buscar lo que falta por publicar no se degrada con el
 *   histórico.
 * - **`version`** viaja en el sobre de cada evento, como pide la historia: es la versión del
 *   CONTRATO del evento, para que un consumidor pueda distinguir una carga vieja de una nueva
 *   cuando el formato cambie. Arranca en 1 para todo lo existente.
 *
 * `processed_events` es la contraparte en el consumidor: su llave primaria compuesta
 * `(event_id, consumer)` es la que hace idempotente el procesamiento —dos entregas del mismo
 * evento compiten por insertar la misma fila y sólo una gana—, y el `consumer` está en la llave
 * porque cada consumidor procesa el mismo evento por su cuenta y no debe bloquear a los demás.
 */
export class IntroduceTransactionalOutbox1784300000062
  implements MigrationInterface
{
  name = 'IntroduceTransactionalOutbox1784300000062';

  /**
   * Agrega `published_at` y `version` a `events`, su índice parcial, y crea `processed_events`.
   *
   * Las filas existentes se marcan como ya publicadas: son la traza de eventos que de hecho se
   * publicaron en su momento, y dejarlas en `NULL` haría que la primera purga las reenviara todas.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla `events` no existe.
   *
   * @example
   * ```ts
   * await new IntroduceTransactionalOutbox1784300000062().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `UPDATE "events" SET "published_at" = "created_at" WHERE "published_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_events_pending_publication"
         ON "events" ("created_at") WHERE "published_at" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "processed_events" (
         "event_id" uuid NOT NULL,
         "consumer" character varying NOT NULL,
         "processed_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_processed_events" PRIMARY KEY ("event_id", "consumer")
       )`,
    );
  }

  /**
   * Elimina `processed_events`, el índice parcial y las dos columnas.
   *
   * Se pierde el registro de qué eventos ya se procesaron: al revertir, el código anterior no
   * consulta esa tabla, así que la idempotencia deja de existir con o sin las filas.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new IntroduceTransactionalOutbox1784300000062().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "processed_events"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_events_pending_publication"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN IF EXISTS "version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN IF EXISTS "published_at"`,
    );
  }
}
