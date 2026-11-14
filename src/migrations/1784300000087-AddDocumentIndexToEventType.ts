import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `document.index` al enum `events_event_type_enum`.
 *
 * La solicitud de indexación de un documento se registra en la outbox (`events`) dentro de la
 * transacción que crea el documento. Sin este valor el `INSERT` falla y, como la outbox comparte
 * la transacción, revertiría la creación de todo documento indexable.
 *
 * `ADD VALUE IF NOT EXISTS` para que sea idempotente, igual que
 * `AddCollaboratorSignedToEventType`. Postgres 12+ lo admite dentro de la transacción de la
 * migración porque el valor nuevo no se usa en esa misma transacción.
 *
 * El `down()` queda vacío a propósito: Postgres no sabe quitar un valor de un enum, y emularlo
 * —recrear el tipo sin ese valor— borraría las filas de `events` que ya lo usan.
 */
export class AddDocumentIndexToEventType1784300000087 implements MigrationInterface {
  name = 'AddDocumentIndexToEventType1784300000087';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'document.index' AFTER 'document.cancelled'`,
    );
  }

  public async down(): Promise<void> {
    // Sin reversa: ver el docblock de la clase.
  }
}
