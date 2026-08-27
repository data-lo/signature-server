import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `provider_resource_id` en `webhook_events`: a qué objeto del proveedor se refiere la entrega.
 *
 * Para Didit es el `session_id`. La idempotencia sigue siendo `UNIQUE(provider,
 * provider_event_id)` —una entrega, una fila—, pero esa clave no permite responder la pregunta
 * operativa real: "qué le pasó a esta sesión de verificación". Una sesión produce varias
 * entregas (`In Progress` → `Approved`), y sin esta columna reconstruir su historia obligaría a
 * escarbar dentro del `jsonb` del payload, sin índice que valga.
 *
 * El índice es compuesto con `provider` porque dos proveedores pueden usar el mismo formato de
 * identificador y toda consulta útil filtra por ambos.
 */
export class AddProviderResourceIdToWebhookEvents1784300000031 implements MigrationInterface {
  name = 'AddProviderResourceIdToWebhookEvents1784300000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD "provider_resource_id" character varying`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_events_provider_resource" ON "webhook_events" ("provider", "provider_resource_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_webhook_events_provider_resource"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP COLUMN "provider_resource_id"`,
    );
  }
}
