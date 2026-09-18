import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tablas deprecadas que se eliminan, con el motivo de cada una.
 *
 * - `account_members_deprecated`, `accounts_legacy_tenant`: copias de sólo lectura que dejó
 *   `MergeAccountAndOrganization` al fusionar cuenta y membresía en `accounts`. Todos sus datos
 *   se copiaron a `accounts`/`organizations` en esa migración y ningún código las lee.
 * - `document_participants_deprecated`: ídem, de `CreateCollaboratorsFromDocumentParticipants`;
 *   cada fila tiene su copia en `collaborators` con el mismo `id`.
 * - `account_subscriptions`: modelo de suscripción anterior a `billing_profiles`. Sólo lo escribía
 *   el webhook de Stripe "por compatibilidad"; nada lo leía desde que el estado de suscripción sale
 *   de `billing_profiles`.
 * - `fiel_signatures`: modelo de datos que nunca tuvo lógica conectada. La firma avanzada se guarda
 *   en `collaborators.advanced_signature`.
 *
 * El orden importa: `account_members_deprecated` referencia a `accounts_legacy_tenant`.
 */
const DEPRECATED_TABLES = [
  'account_members_deprecated',
  'document_participants_deprecated',
  'accounts_legacy_tenant',
  'account_subscriptions',
  'fiel_signatures',
] as const;

/**
 * Columnas deprecadas o sin uso: ningún flujo las escribe ni las lee.
 *
 * - `collaborators.fiel_signature_id`: FK hacia `fiel_signatures`.
 * - `collaborators.comments`, `collaborators.reminder_periodicity`,
 *   `documents.expiration_date`, `documents.reviewed_by`: reservadas en el plan ER-V2 para flujos
 *   que nunca se construyeron; siempre en NULL.
 * - `documents.seal_key`: identificador de sellado de antes de `document_seals`; siempre en NULL.
 * - `accounts.membership_id`: referencia sin FK a `account_subscriptions`; siempre en NULL.
 * - `organizations.legacy_account_id`: puente hacia `accounts_legacy_tenant` que
 *   `MergeAccountAndOrganization` dejó sólo para su `down()`. Sólo existe en las bases construidas
 *   desde migraciones: las que alguna vez se sincronizaron desde las entidades nunca la tuvieron.
 * - `users.is_configured`: bandera del onboarding anterior. La sustituyó
 *   `signing_credential_status` y sólo la escribía `PATCH /users/me/status`, retirado junto con
 *   ella.
 */
const DEPRECATED_COLUMNS: ReadonlyArray<
  readonly [table: string, column: string]
> = [
  ['collaborators', 'fiel_signature_id'],
  ['collaborators', 'comments'],
  ['collaborators', 'reminder_periodicity'],
  ['documents', 'expiration_date'],
  ['documents', 'seal_key'],
  ['documents', 'reviewed_by'],
  ['accounts', 'membership_id'],
  ['organizations', 'legacy_account_id'],
  ['users', 'is_configured'],
];

/** Tipos enum que sólo usaban las tablas y columnas eliminadas. */
const DEPRECATED_ENUM_TYPES = [
  'collaborators_reminder_periodicity_enum',
  'account_subscriptions_plan_id_enum',
  'account_subscriptions_status_enum',
  'document_participants_role_enum',
  'document_participants_status_enum',
  'accounts_legacy_tenant_type_enum',
] as const;

/**
 * Elimina del esquema las tablas, columnas, relaciones y tipos deprecados.
 *
 * **Funciona igual desde una base limpia que sobre una existente.** Los nombres de FKs, índices y
 * constraints de estas tablas NO coinciden entre entornos: unos salieron de las migraciones
 * (`FK_fiel_signatures_verification_code_id`) y otros de cuando el esquema se sincronizaba desde
 * las entidades (`FK_d680d672f32d9668a50b06db002`). Por eso no se borra nada por nombre: cada
 * objeto dependiente se busca en el catálogo de Postgres por tabla y columna. Todo lleva
 * `IF EXISTS`, así que una base donde algo ya no esté tampoco falla.
 *
 * **Orden:** 1) FKs, 2) índices y constraints dependientes, 3) columnas, 4) tablas, 5) tipos enum.
 * Postgres borraría casi todo en cascada, pero hacerlo explícito deja claro qué se pierde y evita
 * un `CASCADE` que se llevara por delante algo no previsto.
 *
 * **Salvaguarda de datos.** Antes de tocar nada se comprueba que `account_subscriptions` no tenga
 * una suscripción de Stripe que `billing_profiles` desconozca. Si la hay, la migración se detiene
 * en vez de perder el único registro de un cobro: primero hay que migrar ese dato.
 */
export class DropDeprecatedSchema1784300000057 implements MigrationInterface {
  name = 'DropDeprecatedSchema1784300000057';

  /**
   * Borra el esquema deprecado en orden seguro.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {Error} Si `account_subscriptions` tiene suscripciones de Stripe sin su perfil en
   * `billing_profiles`.
   *
   * @example
   * ```ts
   * await new DropDeprecatedSchema1784300000057().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertNoOrphanSubscriptions(queryRunner);

    // 1) Foreign keys: las propias de las tablas deprecadas, las que apuntan a ellas y las de las
    //    columnas deprecadas.
    for (const constraint of await this.findConstraints(queryRunner, ['f'])) {
      await this.dropConstraint(queryRunner, constraint);
    }

    // 2) Índices y constraints dependientes (UNIQUE, CHECK, índices sueltos). Las PK se van con
    //    su tabla.
    for (const constraint of await this.findConstraints(queryRunner, [
      'u',
      'c',
      'x',
    ])) {
      await this.dropConstraint(queryRunner, constraint);
    }
    for (const index of await this.findStandaloneIndexes(queryRunner)) {
      await queryRunner.query(`DROP INDEX IF EXISTS "public"."${index}"`);
    }

    // 3) Columnas.
    for (const [table, column] of DEPRECATED_COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE IF EXISTS "${table}" DROP COLUMN IF EXISTS "${column}"`,
      );
    }

    // 4) Tablas.
    for (const table of DEPRECATED_TABLES) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    // 5) Tipos enum que quedaron sin columnas.
    for (const type of DEPRECATED_ENUM_TYPES) {
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }
  }

  /**
   * Recrea la ESTRUCTURA eliminada, vacía.
   *
   * Los datos de las tablas legacy no se restauran: eran copias de lo que ya vive en `accounts`,
   * `organizations` y `collaborators`, y `account_subscriptions` no tenía lector. Las columnas
   * vuelven con sus defaults (`users.is_configured` en `false` para todos). Los nombres y reglas
   * de las constraints son los de las migraciones que las crearon (`InitialSchema`,
   * `MergeAccountAndOrganization`, `CreateFielSignatures`), no los de un entorno concreto.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new DropDeprecatedSchema1784300000057().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_reminder_periodicity_enum" AS ENUM('none', 'daily', 'weekly')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_subscriptions_plan_id_enum" AS ENUM('basic', 'pro', 'enterprise')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_subscriptions_status_enum" AS ENUM('incomplete', 'active', 'past_due', 'canceled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."document_participants_role_enum" AS ENUM('signer', 'spectator')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."document_participants_status_enum" AS ENUM('pending', 'signed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_legacy_tenant_type_enum" AS ENUM('PERSONAL', 'ORGANIZATION')`,
    );

    await queryRunner.query(`
      CREATE TABLE "fiel_signatures" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "rfc" character varying NOT NULL,
        "verification_code_id" uuid,
        "verification_code_required" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_fiel_signatures" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "account_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "plan_id" "public"."account_subscriptions_plan_id_enum",
        "stripe_customer_id" character varying,
        "stripe_subscription_id" character varying,
        "status" "public"."account_subscriptions_status_enum" NOT NULL DEFAULT 'incomplete',
        "current_period_end" TIMESTAMP,
        "signing_enabled" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_e824b033b6e49e61194ddb3f797" UNIQUE ("account_id"),
        CONSTRAINT "PK_83a2cc0a3f89e9085f741552db1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "accounts_legacy_tenant" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "type" "public"."accounts_legacy_tenant_type_enum" NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "account_members_deprecated" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "position" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        "role_id" uuid,
        CONSTRAINT "UQ_64ad7a24bdd270694561759c6b7" UNIQUE ("account_id", "user_id"),
        CONSTRAINT "PK_9c6f17f4d2ab7caa5f03606020f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "document_participants_deprecated" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" "public"."document_participants_role_enum" NOT NULL,
        "status" "public"."document_participants_status_enum" NOT NULL DEFAULT 'pending',
        "sign_order" integer NOT NULL DEFAULT 0,
        "signed_at" TIMESTAMP,
        "rejected_at" TIMESTAMP,
        "rejection_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_98e9a565deb17c99eb40b5cd57d" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_configured" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD "membership_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "legacy_account_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD "expiration_date" TIMESTAMP,
        ADD "seal_key" character varying,
        ADD "reviewed_by" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "collaborators"
        ADD "comments" text,
        ADD "reminder_periodicity" "public"."collaborators_reminder_periodicity_enum",
        ADD "fiel_signature_id" uuid
    `);

    await queryRunner.query(
      `ALTER TABLE "fiel_signatures" ADD CONSTRAINT "FK_fiel_signatures_verification_code_id" FOREIGN KEY ("verification_code_id") REFERENCES "verification_codes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_fiel_signature_id" FOREIGN KEY ("fiel_signature_id") REFERENCES "fiel_signatures"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`
      ALTER TABLE "collaborators" ADD CONSTRAINT "CHK_collaborators_single_signature_type" CHECK (
        "simple_signature_id" IS NULL OR "fiel_signature_id" IS NULL
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" ADD CONSTRAINT "FK_account_subscriptions_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members_deprecated" ADD CONSTRAINT "FK_9beab0863ddc39238af9b8b95dd" FOREIGN KEY ("account_id") REFERENCES "accounts_legacy_tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members_deprecated" ADD CONSTRAINT "FK_28435cf7197859fae41e0be3560" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members_deprecated" ADD CONSTRAINT "FK_account_members_role_id" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants_deprecated" ADD CONSTRAINT "FK_35bf22b44d913d26b80210d54fd" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants_deprecated" ADD CONSTRAINT "FK_4bfded4a297643b190ca889a7e2" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  /**
   * Detiene la migración si `account_subscriptions` guarda una suscripción de Stripe que
   * `billing_profiles` no tiene.
   *
   * Sólo cuentan las filas con `stripe_subscription_id`: las `incomplete` sin él son checkouts que
   * nunca se pagaron. No se exige que el estado coincida, porque aquella tabla dejó de reflejar
   * las activaciones hace tiempo; basta con que el perfil conozca la suscripción.
   */
  private async assertNoOrphanSubscriptions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!(await queryRunner.hasTable('account_subscriptions'))) {
      return;
    }

    const orphans: Array<{ id: string; stripe_subscription_id: string }> =
      await queryRunner.query(`
        SELECT s."id", s."stripe_subscription_id"
        FROM "account_subscriptions" s
        WHERE s."stripe_subscription_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "billing_profiles" bp
            WHERE bp."stripe_subscription_id" = s."stripe_subscription_id"
          )
      `);

    if (orphans.length > 0) {
      throw new Error(
        `account_subscriptions tiene ${orphans.length} suscripción(es) de Stripe sin perfil en ` +
          `billing_profiles (${orphans.map((row) => row.stripe_subscription_id).join(', ')}). ` +
          'Migra esos datos antes de eliminar la tabla.',
      );
    }
  }

  /**
   * Constraints de los tipos pedidos que dependen de lo que se elimina: las definidas en una tabla
   * deprecada, las que la referencian, o las que usan alguna columna deprecada.
   */
  private async findConstraints(
    queryRunner: QueryRunner,
    types: string[],
  ): Promise<Array<{ table: string; name: string }>> {
    return queryRunner.query(
      `
      SELECT DISTINCT rel.relname AS "table", con.conname AS "name"
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      LEFT JOIN pg_class ref ON ref.oid = con.confrelid
      WHERE ns.nspname = 'public'
        AND con.contype = ANY($1)
        AND (
          rel.relname = ANY($2)
          OR ref.relname = ANY($2)
          OR EXISTS (
            SELECT 1
            FROM unnest(con.conkey) AS key(attnum)
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
            WHERE (rel.relname || '.' || att.attname) = ANY($3)
          )
        )
      `,
      [types, DEPRECATED_TABLES, this.qualifiedColumns()],
    );
  }

  /** Índices que no respaldan una constraint y usan alguna columna deprecada. */
  private async findStandaloneIndexes(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: Array<{ name: string }> = await queryRunner.query(
      `
      SELECT DISTINCT idx.relname AS "name"
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class rel ON rel.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(i.indkey)
      WHERE ns.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
        AND (rel.relname || '.' || att.attname) = ANY($1)
      `,
      [this.qualifiedColumns()],
    );
    return rows.map((row) => row.name);
  }

  private async dropConstraint(
    queryRunner: QueryRunner,
    constraint: { table: string; name: string },
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "${constraint.table}" DROP CONSTRAINT IF EXISTS "${constraint.name}"`,
    );
  }

  private qualifiedColumns(): string[] {
    return DEPRECATED_COLUMNS.map(([table, column]) => `${table}.${column}`);
  }
}
