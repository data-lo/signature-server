import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `INDEXER` al enum `webhook_events_provider_enum`, para registrar en la bitácora las entregas
 * de `POST /api/v1/webhooks/indexer`. Sin este valor hasta la auditoría de una firma inválida falla.
 *
 * `ADD VALUE IF NOT EXISTS` para que sea idempotente, igual que `AddDocumentIndexToEventType`.
 * Postgres 12+ lo admite dentro de la transacción de la migración porque el valor nuevo no se usa en
 * esa misma transacción.
 *
 * El `down()` queda vacío a propósito: Postgres no sabe quitar un valor de un enum, y emularlo
 * —recrear el tipo sin ese valor— borraría las filas de `webhook_events` que ya lo usan.
 */
export class AddIndexerToWebhookProvider1784300000090 implements MigrationInterface {
  name = 'AddIndexerToWebhookProvider1784300000090';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."webhook_events_provider_enum" ADD VALUE IF NOT EXISTS 'INDEXER'`,
    );
  }

  public async down(): Promise<void> {
    // Sin reversa: ver el docblock de la clase.
  }
}
