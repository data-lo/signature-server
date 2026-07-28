import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tabla de eventos de dominio para trazabilidad (diagrama ER-V2 más reciente, nuevo módulo
 * `event`). Sin FKs a propósito — ver docblock de `EventEntity`: la trazabilidad fina vive
 * dentro de `metadata` (jsonb), no como relación real.
 */
export class CreateEvents1784300000012 implements MigrationInterface {
  name = 'CreateEvents1784300000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."events_event_type_enum" AS ENUM(
        'document.created',
        'document.sent_to_sign',
        'document.signed',
        'document.rejected',
        'document.cancellation_requested',
        'document.cancelled',
        'organization.member.invited'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE "events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_type" "public"."events_event_type_enum" NOT NULL,
        "metadata" jsonb,
        "from" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_events" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "events"`);
    await queryRunner.query(`DROP TYPE "public"."events_event_type_enum"`);
  }
}
