import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sesión pública de firma por invitación (historia "Estructurar controladores, guards y contextos
 * de actor para API interna, integración externa y firma pública"):
 *
 * 1. `public_signing_access` en `verification_codes_event_enum`: el código que se envía al correo
 *    de la invitación individual (`/sign/:token`).
 * 2. `PUBLIC_SIGNING_SESSION` en `guest_signing_accesses_purpose_enum`: el acceso temporal que se
 *    emite al validarlo y que viaja en la cookie de la sesión pública. Reutiliza la tabla
 *    `guest_signing_accesses` (revocable, consumible, a lo sumo uno abierto por colaborador y
 *    propósito).
 *
 * Sin `transaction = false`: los `ADD VALUE` sólo declaran los valores y ninguna sentencia de esta
 * migración escribe una fila con ellos (mismo criterio que `CreateGuestSigningAccesses`).
 */
export class AddPublicSigningSessionValues1784300000084 implements MigrationInterface {
  name = 'AddPublicSigningSessionValues1784300000084';

  /**
   * Declara el evento del código y el propósito del acceso.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen los tipos.
   *
   * @example
   * ```ts
   * await new AddPublicSigningSessionValues1784300000084().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."verification_codes_event_enum" ADD VALUE IF NOT EXISTS 'public_signing_access'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."guest_signing_accesses_purpose_enum" ADD VALUE IF NOT EXISTS 'PUBLIC_SIGNING_SESSION'`,
    );
  }

  /**
   * No quita los valores: Postgres no elimina un valor de un enum sin recrear el tipo, y puede
   * haber códigos y accesos emitidos con ellos. Sólo revoca las sesiones públicas abiertas, para
   * que el código anterior a esta migración no herede accesos que no sabe validar.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla no existe.
   *
   * @example
   * ```ts
   * await new AddPublicSigningSessionValues1784300000084().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "guest_signing_accesses" SET "revoked_at" = now() WHERE "purpose" = 'PUBLIC_SIGNING_SESSION' AND "consumed_at" IS NULL AND "revoked_at" IS NULL`,
    );
  }
}
