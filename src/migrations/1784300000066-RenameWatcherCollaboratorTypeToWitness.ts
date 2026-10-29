import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia "Renombrar rol Espectador a Testigo": el tipo de colaborador `WATCHER` pasa a llamarse
 * `WITNESS`.
 *
 * Misma estrategia que `UppercaseSignatureAndCollaboratorTypes`: `RENAME VALUE` sobre el enum de
 * Postgres, no `ADD VALUE` + `UPDATE`. Los enums se guardan por OID, así que **toda fila existente
 * con `WATCHER` se lee como `WITNESS` en cuanto corre la migración**, sin reescribir datos y sin
 * una ventana en la que convivan los dos nombres. Es también lo que conserva los registros
 * anteriores: no se pierde ni se reinterpreta ninguno.
 *
 * Sólo toca `collaborators_colaborator_type_enum`. `notifications_actor_type_enum` también tiene
 * un valor `watcher`, pero significa otra cosa —"destinatario invitado sólo por correo, sin
 * cuenta", sea cual sea su rol en el documento (ver `ACTOR_TYPE_ENUM`)— y renombrarlo a testigo
 * sería falso.
 *
 * Corre transaccional: sólo renombra una etiqueta existente, no escribe filas con un valor recién
 * declarado, así que no aplica la restricción 55P04 de Postgres.
 */
export class RenameWatcherCollaboratorTypeToWitness1784300000066 implements MigrationInterface {
  name = 'RenameWatcherCollaboratorTypeToWitness1784300000066';

  /**
   * Renombra la etiqueta `WATCHER` a `WITNESS`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la etiqueta `WATCHER` no existe — señal de que la base ya está
   *   migrada o no viene del esquema esperado.
   *
   * @example
   * ```ts
   * await new RenameWatcherCollaboratorTypeToWitness1784300000066().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'WATCHER' TO 'WITNESS'`,
    );
  }

  /**
   * Devuelve la etiqueta a `WATCHER`. Las filas vuelven a leerse con el nombre anterior por lo
   * mismo que en `up`: cambia la etiqueta, no el dato.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la etiqueta `WITNESS` no existe.
   *
   * @example
   * ```ts
   * await new RenameWatcherCollaboratorTypeToWitness1784300000066().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."collaborators_colaborator_type_enum" RENAME VALUE 'WITNESS' TO 'WATCHER'`,
    );
  }
}
