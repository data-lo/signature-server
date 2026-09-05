import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `document.collaborator_signed` al enum `events_event_type_enum`.
 *
 * El valor existe en `EVENT_TYPE_ENUM` desde que `DocumentEventsProducer.emitCollaboratorSigned`
 * empezó a emitir un evento por CADA firmante, pero ninguna migración llegó a agregarlo a la base:
 * el esquema se venía manteniendo con `synchronize: true`, que lo creaba solo, así que el hueco
 * sólo se ve en una base construida a partir de las migraciones —donde registrar ese evento falla.
 *
 * `ADD VALUE IF NOT EXISTS` para que sea idempotente y para no romper en las bases que ya lo tienen
 * porque `synchronize` se lo puso. Postgres 12+ admite esta sentencia dentro de la transacción de la
 * migración siempre que el valor nuevo no se use en esa misma transacción, que es el caso.
 *
 * El `down()` queda vacío a propósito: Postgres no sabe quitar un valor de un enum, y emularlo
 * —recrear el tipo sin ese valor— borraría las filas de `events` que ya lo usan.
 */
export class AddCollaboratorSignedToEventType1784300000040 implements MigrationInterface {
  name = 'AddCollaboratorSignedToEventType1784300000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'document.collaborator_signed' AFTER 'document.sent_to_sign'`,
    );
  }

  public async down(): Promise<void> {
    // Sin reversa: ver el docblock de la clase.
  }
}
