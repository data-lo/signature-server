import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Declara los tres tipos de evento del flujo de aprobación en `events_event_type_enum`
 * (historia "Implementar flujo de aprobación previo al proceso de firma").
 *
 * La tabla `events` es la traza en Postgres de lo que se publica en Kafka, y su columna
 * `event_type` es un enum: sin estas tres etiquetas, `EventService.create` falla al registrar un
 * evento de aprobación y la traza se queda con un agujero justo en las transiciones nuevas.
 *
 * `document.approval_rejected` es deliberadamente distinto de `document.rejected`: el primero es
 * el reviewer negándose a autorizar el documento —el flujo de firma nunca empieza—, y el segundo
 * es un firmante rechazándolo ya dentro de ese flujo. Colapsarlos obligaría a cualquier
 * consumidor a mirar el estado del documento para saber qué pasó realmente.
 *
 * Sin `transaction = false`: la restricción 55P04 de Postgres aplica cuando se ESCRIBE una fila
 * con el valor recién declarado en la misma transacción, y aquí sólo se declara (mismo criterio
 * que `AddCollaboratorSignedToEventType`).
 */
export class AddApprovalEventTypes1784300000061 implements MigrationInterface {
  name = 'AddApprovalEventTypes1784300000061';

  /**
   * Agrega los tres valores al enum de tipos de evento.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si el tipo `events_event_type_enum` no existe.
   *
   * @example
   * ```ts
   * await new AddApprovalEventTypes1784300000061().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'document.approval_requested'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'document.approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'document.approval_rejected'`,
    );
  }

  /**
   * No hace nada, a propósito: Postgres no elimina un valor de enum sin recrear el tipo completo,
   * y para entonces podría haber filas en `events` usándolo. Una etiqueta de más en el enum no
   * afecta a ningún consumidor.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new AddApprovalEventTypes1784300000061().down(); // no-op
   * ```
   */
  public async down(): Promise<void> {
    // Ver el docblock: quitar un valor de enum exige recrear el tipo.
  }
}
