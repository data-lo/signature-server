import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Declara `organization.member.joined` en `events_event_type_enum` (historia "Notificar a
 * propietarios y administradores cuando un usuario se une a una organización").
 *
 * La tabla `events` es además la outbox transaccional (ver `OutboxService`), así que sin esta
 * etiqueta la transacción que da de alta a un miembro revienta al registrar el evento — y con
 * ella la incorporación entera, no sólo el aviso.
 *
 * El valor es distinto de `organization.member.invited` a propósito: aquel es la intención de
 * invitar —que puede expirar o no aceptarse nunca— y éste el hecho de que alguien quedó dentro.
 *
 * Sin `transaction = false`: la restricción 55P04 de Postgres aplica cuando se ESCRIBE una fila
 * con el valor recién declarado en la misma transacción, y aquí sólo se declara (mismo criterio
 * que `AddApprovalEventTypes`).
 */
export class AddOrganizationMemberJoinedEventType1784300000065 implements MigrationInterface {
  name = 'AddOrganizationMemberJoinedEventType1784300000065';

  /**
   * Agrega el valor al enum de tipos de evento.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si el tipo `events_event_type_enum` no existe.
   *
   * @example
   * ```ts
   * await new AddOrganizationMemberJoinedEventType1784300000065().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."events_event_type_enum" ADD VALUE IF NOT EXISTS 'organization.member.joined'`,
    );
  }

  /**
   * No hace nada, a propósito: Postgres no elimina un valor de enum sin recrear el tipo completo,
   * y para entonces podría haber filas en `events` usándolo.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new AddOrganizationMemberJoinedEventType1784300000065().down(); // no-op
   * ```
   */
  public async down(): Promise<void> {
    // Ver el docblock: quitar un valor de enum exige recrear el tipo.
  }
}
