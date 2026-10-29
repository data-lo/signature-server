import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Accesos temporales desde el portal de un tercero (historia "Integrar acceso a firma desde correo
 * y portal de terceros con validación de email por invitación"): la tabla `signing_launch_tokens`,
 * que resuelve `/sign/launch/:token` a la invitación de un firmante.
 *
 * Un token de lanzamiento vive minutos y se usa una vez: `consumed_at` se marca con un `UPDATE`
 * condicionado al canjearlo, así que dos aperturas simultáneas no pueden usar el mismo. No autoriza
 * la firma: lleva a la misma validación del código del correo que la invitación.
 *
 * Restricciones:
 * - `UQ_signing_launch_tokens_token_hash`: el token se busca por su hash.
 * - `CHK_signing_launch_tokens_expiry`: vence después de emitirse.
 */
export class CreateSigningLaunchTokens1784300000085 implements MigrationInterface {
  name = 'CreateSigningLaunchTokens1784300000085';

  /**
   * Crea la tabla de tokens de lanzamiento y sus índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `signing_invitations` o `api_keys`.
   *
   * @example
   * ```ts
   * await new CreateSigningLaunchTokens1784300000085().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "signing_launch_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "invitation_id" uuid NOT NULL,
        "token_hash" character varying(64) NOT NULL,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "issued_via_api_key_id" uuid,
        "issued_ip_address" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_signing_launch_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_signing_launch_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "CHK_signing_launch_tokens_expiry"
          CHECK ("expires_at" > "issued_at"),
        CONSTRAINT "FK_signing_launch_tokens_invitation_id"
          FOREIGN KEY ("invitation_id") REFERENCES "signing_invitations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_signing_launch_tokens_api_key_id"
          FOREIGN KEY ("issued_via_api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_signing_launch_tokens_invitation" ON "signing_launch_tokens" ("invitation_id")`,
    );
  }

  /**
   * Elimina la tabla (sus índices caen con ella).
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla ya no existe.
   *
   * @example
   * ```ts
   * await new CreateSigningLaunchTokens1784300000085().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "signing_launch_tokens"`);
  }
}
