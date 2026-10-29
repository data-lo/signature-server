import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invitaciones individuales de firma por token (historia "Refactorizar la pantalla pública de
 * firma para reutilizar flujos por tipo de firma e incorporar acceso por invitación"): la tabla
 * `signing_invitations`, que resuelve `/sign/:token` a su documento y su firmante.
 *
 * Restricciones:
 * - `UQ_signing_invitations_token_hash`: el token se busca por su hash, y dos invitaciones nunca
 *   comparten uno.
 * - `UQ_signing_invitations_open` (parcial): a lo sumo una invitación sin revocar por colaborador.
 *   La vigencia no entra en el índice —`now()` no es inmutable—, así que emitir una nueva revoca
 *   antes la abierta, vencida o no.
 * - `CHK_signing_invitations_expiry`: vence después de emitirse.
 */
export class CreateSigningInvitations1784300000083 implements MigrationInterface {
  name = 'CreateSigningInvitations1784300000083';

  /**
   * Crea la tabla de invitaciones y sus índices.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `documents` o `collaborators`.
   *
   * @example
   * ```ts
   * await new CreateSigningInvitations1784300000083().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "signing_invitations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "collaborator_id" uuid NOT NULL,
        "token_hash" character varying(64) NOT NULL,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_signing_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_signing_invitations_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "CHK_signing_invitations_expiry"
          CHECK ("expires_at" > "issued_at"),
        CONSTRAINT "FK_signing_invitations_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_signing_invitations_collaborator_id"
          FOREIGN KEY ("collaborator_id") REFERENCES "collaborators"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_signing_invitations_collaborator" ON "signing_invitations" ("collaborator_id")`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_signing_invitations_open" ON "signing_invitations" ("collaborator_id") WHERE "revoked_at" IS NULL`,
    );
  }

  /**
   * Elimina la tabla de invitaciones (sus índices caen con ella).
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si la tabla ya no existe.
   *
   * @example
   * ```ts
   * await new CreateSigningInvitations1784300000083().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "signing_invitations"`);
  }
}
