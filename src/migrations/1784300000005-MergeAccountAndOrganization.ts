import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 5 (ver plan de migración) — la de mayor riesgo de todo el plan, pero
 * simplificada porque el proyecto todavía no tiene usuarios/datos reales en producción
 * (confirmado con el equipo): se ejecuta como una sola migración conectada, sin dual-write ni
 * período de "bake" en producción, pero siguiendo igual el estilo de migraciones del repo
 * (SQL crudo, backfill, down() honesto) porque el ambiente de desarrollo actual sí tiene datos
 * de prueba que conviene preservar.
 *
 * Dos cambios estructurales a la vez:
 *
 * 1. Organization pasa a ser una entidad propia (con su propio id), en vez de colgar de
 *    accountId como OrganizationDetailEntity. Necesario porque Account deja de identificar al
 *    tenant compartido (ver punto 2) — Organization es ahora la única identidad estable que
 *    comparten todos los miembros de una misma organización.
 *
 * 2. Account fusiona lo que antes eran AccountEntity (el tenant) + AccountMemberEntity (la
 *    membresía) en una sola fila por (usuario × contexto) — decisión D5 confirmada con el
 *    equipo ("fusión literal"). email/password se sincronizan desde la credencial única del
 *    usuario (decisión D6) — Users.email/.password NO se eliminan: siguen siendo la fuente
 *    primaria para búsqueda/notificaciones en el dominio de documentos (ver nota en el plan,
 *    Fase 5) — Account.email/.password son una copia sincronizada, usada solo para resolver
 *    el login.
 *
 * Ninguna tabla vieja se borra — se renombra a _legacy_tenant/_deprecated y queda de solo
 * lectura, disponible para down() y como referencia de auditoría/rollback de emergencia.
 * `organizations.legacy_account_id` tampoco se elimina al final (a propósito): es lo que hace
 * posible que down() reconstruya organization_details sin pérdida de datos.
 *
 * documents.account_id pasa a significar "qué membresía específica creó/posee este documento"
 * (para personal, coincide con el tenant; para organización, es la fila del creador dentro de
 * esa org). documents.organization_id (agregado como no-op en la Fase 1) se convierte en la
 * clave real de aislamiento multi-tenant para documentos en contexto de organización — ver
 * document.service.ts, decisión D5.
 */
export class MergeAccountAndOrganization1784300000005 implements MigrationInterface {
  name = 'MergeAccountAndOrganization1784300000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- U1: Organization como entidad propia, poblada desde organization_details ----
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "address" text,
        "rfc" character varying,
        "domain_allowed" character varying,
        "phone_number" character varying,
        "index_documents" boolean NOT NULL DEFAULT false,
        "legacy_account_id" uuid,
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "organizations" (
        "id", "name", "is_active", "address", "rfc", "domain_allowed", "phone_number",
        "index_documents", "legacy_account_id"
      )
      SELECT
        uuid_generate_v4(), od."name", od."is_active", od."address", od."rfc",
        od."domain_allowed", od."phone_number", od."index_documents", od."account_id"
      FROM "organization_details" od
    `);

    // ---- U2: renombrar el tenant-container viejo (referencia de solo lectura) ----
    await queryRunner.query(
      `ALTER TABLE "accounts" RENAME TO "accounts_legacy_tenant"`,
    );

    // ---- U3: Account fusionado — una fila por (usuario × contexto) ----
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_status_enum" AS ENUM('pending_invite', 'active', 'suspended', 'removed')`,
    );

    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "account_type" "public"."accounts_type_enum" NOT NULL,
        "organization_id" uuid,
        "role_id" uuid,
        "membership_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "status" "public"."accounts_status_enum" NOT NULL DEFAULT 'active',
        "email" character varying NOT NULL,
        "password" character varying NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "left_at" TIMESTAMP,
        "joined_at" TIMESTAMP,
        "index_documents" boolean NOT NULL DEFAULT false,
        "position" character varying,
        CONSTRAINT "PK_accounts_merged" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "accounts" (
        "id", "user_id", "account_type", "organization_id", "role_id", "created_at",
        "status", "email", "password", "is_active", "joined_at", "position"
      )
      SELECT
        am."id", am."user_id", a."type", org."id", am."role_id", a."created_at",
        (CASE WHEN am."is_active" THEN 'active' ELSE 'removed' END)::"public"."accounts_status_enum",
        u."email", u."password", am."is_active", a."created_at", am."position"
      FROM "account_members" am
      INNER JOIN "accounts_legacy_tenant" a ON a."id" = am."account_id"
      INNER JOIN "users" u ON u."id" = am."user_id"
      LEFT JOIN "organizations" org ON org."legacy_account_id" = am."account_id"
    `);

    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "FK_accounts_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "FK_accounts_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "FK_accounts_role_id" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ---- U4: renombrar la membresía vieja (referencia de solo lectura) ----
    await queryRunner.query(
      `ALTER TABLE "account_members" RENAME TO "account_members_deprecated"`,
    );

    // ---- U5: roles.organization_id ahora apunta a Organization, no al tenant viejo ----
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "FK_c328a1ecd12a5f153a96df4509e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD CONSTRAINT "FK_roles_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---- U6: documents — account_id se remapea a la membresía del creador; organization_id
    //          (no-op desde la Fase 1) se backfillea con la clave real de tenant ----
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_account_id"`,
    );

    await queryRunner.query(`
      UPDATE "documents" d
      SET "organization_id" = org."id"
      FROM "accounts_legacy_tenant" a
      LEFT JOIN "organizations" org ON org."legacy_account_id" = a."id"
      WHERE a."id" = d."account_id" AND a."type" = 'ORGANIZATION'
    `);

    await queryRunner.query(`
      UPDATE "documents" d
      SET "account_id" = acc."id"
      FROM "accounts" acc
      WHERE acc."user_id" = d."created_by"
        AND (
          (d."organization_id" IS NOT NULL AND acc."organization_id" = d."organization_id")
          OR (d."organization_id" IS NULL AND acc."organization_id" IS NULL)
        )
    `);

    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_organization_id" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ---- U7: account_subscriptions repuntado (tabla vacía hoy, sin backfill necesario) ----
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" DROP CONSTRAINT "FK_e824b033b6e49e61194ddb3f797"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" ADD CONSTRAINT "FK_account_subscriptions_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---- U8: organization_details ya migrada a organizations — se elimina ----
    await queryRunner.query(
      `ALTER TABLE "organization_details" DROP CONSTRAINT "FK_c6539c8350dff84c1a1a46aee86"`,
    );
    await queryRunner.query(`DROP TABLE "organization_details"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversión en orden estrictamente inverso a up(). Nada se pierde: accounts_legacy_tenant,
    // account_members_deprecated y organizations.legacy_account_id conservan toda la
    // información necesaria para reconstruir el estado anterior sin pérdida de datos.

    // D8 (deshace U8) — recrea organization_details con la forma que tenía justo antes de esta
    // migración (InitialSchema + las 6 columnas que le agregó AddOrganizationFields en la
    // Fase 1, que nunca se revirtió), no la forma original de InitialSchema a secas.
    await queryRunner.query(`
      CREATE TABLE "organization_details" (
        "account_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "address" text,
        "rfc" character varying,
        "domain_allowed" character varying,
        "phone_number" character varying,
        "index_documents" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_c6539c8350dff84c1a1a46aee86" PRIMARY KEY ("account_id")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "organization_details" (
        "account_id", "name", "is_active", "address", "rfc", "domain_allowed",
        "phone_number", "index_documents"
      )
      SELECT
        org."legacy_account_id", org."name", org."is_active", org."address", org."rfc",
        org."domain_allowed", org."phone_number", org."index_documents"
      FROM "organizations" org
      WHERE org."legacy_account_id" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "organization_details" ADD CONSTRAINT "FK_c6539c8350dff84c1a1a46aee86" FOREIGN KEY ("account_id") REFERENCES "accounts_legacy_tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // D7 (deshace U7)
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" DROP CONSTRAINT "FK_account_subscriptions_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" ADD CONSTRAINT "FK_e824b033b6e49e61194ddb3f797" FOREIGN KEY ("account_id") REFERENCES "accounts_legacy_tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // D6 (deshace U6)
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_organization_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_account_id"`,
    );
    await queryRunner.query(`
      UPDATE "documents" d
      SET "account_id" = COALESCE(
        (SELECT org."legacy_account_id" FROM "organizations" org WHERE org."id" = d."organization_id"),
        (
          SELECT am."account_id" FROM "account_members_deprecated" am
          INNER JOIN "accounts_legacy_tenant" a ON a."id" = am."account_id"
          WHERE am."user_id" = d."created_by" AND a."type" = 'PERSONAL'
          LIMIT 1
        )
      )
    `);
    await queryRunner.query(`UPDATE "documents" SET "organization_id" = NULL`);
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts_legacy_tenant"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // D5 (deshace U5)
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "FK_roles_organization_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD CONSTRAINT "FK_c328a1ecd12a5f153a96df4509e" FOREIGN KEY ("organization_id") REFERENCES "accounts_legacy_tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // D4 (deshace U4)
    await queryRunner.query(
      `ALTER TABLE "account_members_deprecated" RENAME TO "account_members"`,
    );

    // D3 (deshace U3) — DROP TABLE arrastra sus propias FKs
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TYPE "public"."accounts_status_enum"`);

    // D2 (deshace U2)
    await queryRunner.query(
      `ALTER TABLE "accounts_legacy_tenant" RENAME TO "accounts"`,
    );

    // D1 (deshace U1)
    await queryRunner.query(`DROP TABLE "organizations"`);
  }
}
