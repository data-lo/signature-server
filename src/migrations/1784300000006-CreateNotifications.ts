import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 6 (ver plan de migración): persiste lo que hasta ahora era
 * fire-and-forget — un envío de correo del ciclo de vida del documento (EmailService) ya
 * ocurría, pero no dejaba ningún registro. Sin backfill: no existe data histórica de
 * notificaciones que migrar, todos los envíos anteriores a esta migración eran efímeros.
 */
export class CreateNotifications1784300000006 implements MigrationInterface {
  name = 'CreateNotifications1784300000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_actor_type_enum" AS ENUM('watcher', 'account')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_notification_channel_source_enum" AS ENUM('email', 'phone_number')`,
    );

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "collaborator_id" uuid,
        "is_notified" boolean NOT NULL DEFAULT false,
        "actor_type" "public"."notifications_actor_type_enum" NOT NULL,
        "document_id" uuid NOT NULL,
        "notification_channel_source" "public"."notifications_notification_channel_source_enum" NOT NULL DEFAULT 'email',
        "delivered" boolean NOT NULL DEFAULT false,
        "sent_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_collaborator_id" FOREIGN KEY ("collaborator_id") REFERENCES "collaborators"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_document_id" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(
      `DROP TYPE "public"."notifications_notification_channel_source_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."notifications_actor_type_enum"`,
    );
  }
}
