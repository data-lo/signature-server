import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia [STORY] Backend: Orquestación para Creación de Documento y Flujo de Firmas —
 * agrega el valor 'notification.created' al enum `events_event_type_enum` (ver EventModule),
 * usado por `NotificationEventsProducer` para registrar trazabilidad de cada notificación
 * creada durante la orquestación de `POST /api/v1/documents/signatures`.
 */
export class AddNotificationCreatedToEventType1784300000013 implements MigrationInterface {
  name = 'AddNotificationCreatedToEventType1784300000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE 'notification.created'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no soporta ALTER TYPE ... DROP VALUE — revertir este valor específico
    // requeriría recrear el tipo entero (rebuild de la tabla events). No se hace acá a
    // propósito: dejar el valor extra en el enum es inofensivo si se revierte la migración.
  }
}
