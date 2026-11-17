import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modelo de datos de los webhooks salientes (módulo `outbound-webhooks`).
 *
 * - `webhook_endpoints`: un destino por sujeto. El sujeto es polimórfico (`subject_type` +
 *   `subject_id`), sin FK; hoy sólo `ORGANIZATION`.
 * - `webhook_secret_versions`: versiones cifradas del secreto HMAC. Un índice parcial admite una
 *   sola versión activa por endpoint; las retiradas se conservan para las entregas que las usan.
 * - `webhook_deliveries`: una entrega por evento y endpoint, idempotente por
 *   `(endpoint_id, source_event_id)`. URL, payload y versión del secreto son snapshots. La FK
 *   compuesta `(secret_version_id, endpoint_id)` impide firmar con el secreto de otro endpoint.
 * - `webhook_delivery_attempts`: un registro por POST.
 *
 * Los estados, tipos y eventos son `varchar` con `CHECK` y no enums de Postgres: el sujeto y los
 * eventos están pensados para crecer, y ampliar un `CHECK` se revierte en `down` sin recrear tipos.
 * Todas las FK son `RESTRICT`: nada de esto se borra en cascada, porque es la traza de qué se
 * notificó a un cliente.
 */
export class CreateOutboundWebhooks1784300000094 implements MigrationInterface {
  name = 'CreateOutboundWebhooks1784300000094';

  /**
   * Crea las cuatro tablas con sus restricciones e índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existe `events` o alguna de las tablas ya existe.
   *
   * @example
   * ```ts
   * await new CreateOutboundWebhooks1784300000094().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_endpoints" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subject_type" character varying(50) NOT NULL,
        "subject_id" uuid NOT NULL,
        "url" text NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'ACTIVE',
        "subscribed_event_types" text array NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "disabled_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_webhook_endpoints" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_endpoints_subject_type" CHECK ("subject_type" IN ('ORGANIZATION')),
        CONSTRAINT "CHK_webhook_endpoints_status" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
        CONSTRAINT "CHK_webhook_endpoints_disabled_at" CHECK (("status" = 'DISABLED') = ("disabled_at" IS NOT NULL)),
        CONSTRAINT "CHK_webhook_endpoints_subscribed_event_types" CHECK (cardinality("subscribed_event_types") > 0 AND "subscribed_event_types" <@ ARRAY['document.collaborator_signed', 'document.signed', 'document.rejected', 'document.cancelled']::text[])
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_endpoints_subject" ON "webhook_endpoints" ("subject_type", "subject_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_secret_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "endpoint_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "encrypted_secret" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "retired_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_webhook_secret_versions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_secret_versions_version" CHECK ("version" >= 1),
        CONSTRAINT "FK_webhook_secret_versions_endpoint_id" FOREIGN KEY ("endpoint_id")
          REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_secret_versions_endpoint_version" ON "webhook_secret_versions" ("endpoint_id", "version")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_secret_versions_active" ON "webhook_secret_versions" ("endpoint_id") WHERE "retired_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_secret_versions_id_endpoint" ON "webhook_secret_versions" ("id", "endpoint_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "endpoint_id" uuid NOT NULL,
        "secret_version_id" uuid NOT NULL,
        "source_event_id" uuid NOT NULL,
        "event_type" character varying(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "destination_url" text NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PENDING',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "last_attempt_at" TIMESTAMP WITH TIME ZONE,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "delivered_at" TIMESTAMP WITH TIME ZONE,
        "last_response_status" integer,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_deliveries_status" CHECK ("status" IN ('PENDING', 'DELIVERING', 'RETRY_SCHEDULED', 'DELIVERED', 'FAILED', 'CANCELLED')),
        CONSTRAINT "CHK_webhook_deliveries_event_type" CHECK ("event_type" IN ('document.collaborator_signed', 'document.signed', 'document.rejected', 'document.cancelled')),
        CONSTRAINT "CHK_webhook_deliveries_attempt_count" CHECK ("attempt_count" >= 0),
        CONSTRAINT "CHK_webhook_deliveries_delivered_at" CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)),
        CONSTRAINT "CHK_webhook_deliveries_lease" CHECK ("status" <> 'DELIVERING' OR "lease_expires_at" IS NOT NULL),
        CONSTRAINT "FK_webhook_deliveries_endpoint_id" FOREIGN KEY ("endpoint_id")
          REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_webhook_deliveries_secret_version_endpoint" FOREIGN KEY ("secret_version_id", "endpoint_id")
          REFERENCES "webhook_secret_versions"("id", "endpoint_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_webhook_deliveries_source_event_id" FOREIGN KEY ("source_event_id")
          REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_deliveries_endpoint_event" ON "webhook_deliveries" ("endpoint_id", "source_event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_status_next_attempt" ON "webhook_deliveries" ("status", "next_attempt_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_endpoint_created_at" ON "webhook_deliveries" ("endpoint_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_delivery_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "delivery_id" uuid NOT NULL,
        "attempt_number" integer NOT NULL,
        "outcome" character varying(20),
        "response_status" integer,
        "duration_ms" integer,
        "error_message" text,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_webhook_delivery_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_delivery_attempts_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('SUCCEEDED', 'HTTP_ERROR', 'NETWORK_ERROR', 'TIMEOUT')),
        CONSTRAINT "CHK_webhook_delivery_attempts_attempt_number" CHECK ("attempt_number" >= 1),
        CONSTRAINT "CHK_webhook_delivery_attempts_finished" CHECK (("finished_at" IS NULL) = ("outcome" IS NULL)),
        CONSTRAINT "FK_webhook_delivery_attempts_delivery_id" FOREIGN KEY ("delivery_id")
          REFERENCES "webhook_deliveries"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_delivery_attempts_delivery_attempt" ON "webhook_delivery_attempts" ("delivery_id", "attempt_number")`,
    );
  }

  /**
   * Borra las cuatro tablas, de la más dependiente a la menos.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si alguna tabla no existe.
   *
   * @example
   * ```ts
   * await new CreateOutboundWebhooks1784300000094().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_delivery_attempts"`);
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
    await queryRunner.query(`DROP TABLE "webhook_secret_versions"`);
    await queryRunner.query(`DROP TABLE "webhook_endpoints"`);
  }
}
