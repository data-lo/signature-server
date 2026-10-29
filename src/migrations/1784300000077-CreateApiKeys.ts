import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API keys de organización (historia "Crear entidades de API Key vinculadas a organizaciones y
 * permisos existentes"). Sólo el modelo: ni endpoints ni validación de llaves.
 *
 * 1. El tipo `api_key_status_enum` (`ACTIVE` | `REVOKED`).
 * 2. La tabla `api_keys`: una fila por llave emitida, vigente o revocada. Las revocadas se
 *    conservan como historial.
 * 3. La tabla pivote `api_key_permissions`, que concede a cada llave permisos del catálogo
 *    existente de `permissions`; no hay un catálogo de scopes propio.
 *
 * Restricciones de `api_keys`:
 * - `uq_api_keys_one_active_per_organization` (parcial): a lo sumo una llave `ACTIVE` por
 *   organización. Las `REVOKED` no ocupan lugar, así que el historial no tiene límite.
 * - `UQ_api_keys_public_id`: el identificador público es único entre todas las llaves.
 * - `IDX_api_keys_organization_id_status`: el historial de una organización y "su llave vigente".
 * - `CHK_api_keys_revocation`: una `ACTIVE` no tiene datos de revocación y una `REVOKED` siempre
 *   tiene `revoked_at`; `revoked_by_account_id` puede faltar (no toda baja la hace una membresía).
 * - `CHK_api_keys_expiry`: si vence, vence después de crearse.
 * - `organization_id` → `CASCADE`, igual que `accounts`. Las dos FK a `accounts` quedan en
 *   `NO ACTION`: la membresía autora no se puede borrar mientras su llave exista, y borrar la
 *   organización las elimina juntas en la misma cascada.
 *
 * En `api_key_permissions`, borrar una llave borra sus permisos (`CASCADE`) y un permiso asignado
 * a alguna llave no se puede borrar (`RESTRICT`). La llave primaria y los dos índices de la pivote
 * llevan el nombre que genera TypeORM para una `@JoinTable` (no deja fijarlo): así
 * `migration:generate` no ve diferencias con la entidad.
 */
export class CreateApiKeys1784300000077 implements MigrationInterface {
  name = 'CreateApiKeys1784300000077';

  /**
   * Crea el tipo de estado, la tabla de llaves y la pivote de permisos con sus restricciones.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `organizations`, `accounts` o `permissions`, o si
   * alguno de los objetos ya existe.
   *
   * @example
   * ```ts
   * await new CreateApiKeys1784300000077().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."api_key_status_enum" AS ENUM('ACTIVE', 'REVOKED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "created_by_account_id" uuid NOT NULL,
        "public_id" character varying NOT NULL,
        "key_prefix" character varying NOT NULL,
        "secret_hash" character varying NOT NULL,
        "name" character varying NOT NULL,
        "status" "public"."api_key_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_account_id" uuid,
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_api_keys_revocation"
          CHECK (("status" = 'ACTIVE' AND "revoked_at" IS NULL AND "revoked_by_account_id" IS NULL) OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)),
        CONSTRAINT "CHK_api_keys_expiry"
          CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
        CONSTRAINT "FK_api_keys_organization_id"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_api_keys_created_by_account_id"
          FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_api_keys_revoked_by_account_id"
          FOREIGN KEY ("revoked_by_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_api_keys_public_id" ON "api_keys" ("public_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_api_keys_one_active_per_organization" ON "api_keys" ("organization_id") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_organization_id_status" ON "api_keys" ("organization_id", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "api_key_permissions" (
        "api_key_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        CONSTRAINT "PK_7055273f0910ff52f3ed950e24a" PRIMARY KEY ("api_key_id", "permission_id"),
        CONSTRAINT "FK_api_key_permissions_api_key_id"
          FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_api_key_permissions_permission_id"
          FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_b714305315131e74ebddc306f3" ON "api_key_permissions" ("api_key_id")`,
    );
    // Sin éste, el `RESTRICT` recorrería la pivote entera al borrar cada permiso.
    await queryRunner.query(
      `CREATE INDEX "IDX_6d5f388ea3d7ba981427e9b64a" ON "api_key_permissions" ("permission_id")`,
    );
  }

  /**
   * Quita la pivote, la tabla de llaves y el tipo de estado.
   *
   * Borra las llaves emitidas, vigentes y revocadas: revertir esta migración pierde el historial.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si las tablas o el tipo ya no existen.
   *
   * @example
   * ```ts
   * await new CreateApiKeys1784300000077().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "api_key_permissions"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`DROP TYPE "public"."api_key_status_enum"`);
  }
}
