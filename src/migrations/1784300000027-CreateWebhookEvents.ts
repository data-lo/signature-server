import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitácora de entregas de webhook de proveedores externos (módulo `webhooks`).
 *
 * El índice único `(provider, provider_event_id)` no es una optimización: es el mecanismo de
 * idempotencia. Postgres no considera iguales dos NULL en un índice único, así que las filas
 * de auditoría de entregas con firma inválida — que no tienen identificador confiable porque
 * no se lee su cuerpo — conviven sin colisionar entre sí.
 */
export class CreateWebhookEvents1784300000027 implements MigrationInterface {
  name = 'CreateWebhookEvents1784300000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."webhook_events_provider_enum" AS ENUM('DIDIT', 'STRIPE')`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."webhook_events_processing_status_enum" AS ENUM('RECEIVED', 'PROCESSED', 'FAILED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" "public"."webhook_events_provider_enum" NOT NULL,
        "provider_event_id" character varying,
        "event_type" character varying NOT NULL,
        "signature_valid" boolean NOT NULL,
        "processing_status" "public"."webhook_events_processing_status_enum" NOT NULL DEFAULT 'RECEIVED',
        "payload" jsonb,
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_events_provider_event" UNIQUE ("provider", "provider_event_id")
      )
    `);

    // Consulta operativa típica: "qué eventos de Stripe quedaron en FAILED".
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_events_provider_status" ON "webhook_events" ("provider", "processing_status")`,
    );

    // Recorridos cronológicos: depuración de entregas y purga de filas viejas.
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_events_received_at" ON "webhook_events" ("received_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(
      `DROP TYPE "public"."webhook_events_processing_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."webhook_events_provider_enum"`);
  }
}
