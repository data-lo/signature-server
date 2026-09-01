import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea el esquema de facturación completo: catálogo comercial, perfiles, órdenes de compra y
 * saldo de documentos.
 *
 * **Por qué llega tarde.** Las entidades de `billing/` se agregaron sin migración, apoyándose en
 * el `synchronize: true` de `app.module.ts`. Eso funciona en desarrollo, pero deja el esquema sin
 * una definición reproducible: hoy sólo existen `plans`, `plan_prices` y `document_pack_offers`
 * —las únicas que algún `forFeature()` había llegado a cargar— y las otras cuatro no existen en
 * ninguna base. Esta migración las escribe todas para que un entorno con `synchronize` apagado
 * pueda construirse desde cero.
 *
 * **Todo va con `IF NOT EXISTS`, a propósito.** No es defensa por costumbre: las bases de los
 * entornos actuales ya tienen parte de estas tablas creadas por `synchronize`, así que una
 * migración que dé por hecho una base limpia fallaría con "relation already exists" justo en los
 * entornos donde ya está corriendo. Así converge desde cualquiera de los dos puntos de partida.
 *
 * Los nombres de constraint e índice se dejan explícitos (y no autogenerados como los de
 * `synchronize`, del tipo `UQ_6e61112f...`) para que el `down` pueda revertirlos sin adivinar y
 * para que dos entornos no terminen con nombres distintos para la misma regla.
 */
export class CreateBillingSchema1784300000034 implements MigrationInterface {
  name = 'CreateBillingSchema1784300000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createEnums(queryRunner);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plans" (
        "code" character varying(64) NOT NULL,
        "name" character varying(120) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "stripe_product_id" character varying,
        "monthly_document_limit" integer NOT NULL,
        "allow_simple_signature" boolean NOT NULL DEFAULT true,
        "allow_advanced_signature" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plans" PRIMARY KEY ("code"),
        CONSTRAINT "CHK_plans_monthly_document_limit" CHECK ("monthly_document_limit" > 0)
      )
    `);
    await this.addUniqueIfMissing(
      queryRunner,
      'plans',
      'UQ_plans_stripe_product_id',
      'stripe_product_id',
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plan_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "plan_code" character varying(64) NOT NULL,
        "stripe_price_id" character varying NOT NULL,
        "amount" integer NOT NULL,
        "currency" character varying(3) NOT NULL,
        "interval" "public"."plan_prices_interval_enum" NOT NULL,
        "interval_count" integer NOT NULL DEFAULT 1,
        "active" boolean NOT NULL DEFAULT true,
        "effective_from" TIMESTAMP WITH TIME ZONE,
        "effective_to" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plan_prices" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_plan_prices_amount" CHECK ("amount" >= 0),
        CONSTRAINT "CHK_plan_prices_interval_count" CHECK ("interval_count" > 0)
      )
    `);
    await this.addUniqueIfMissing(
      queryRunner,
      'plan_prices',
      'UQ_plan_prices_stripe_price_id',
      'stripe_price_id',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'plan_prices',
      'FK_plan_prices_plan',
      'plan_code',
      '"plans"("code") ON DELETE CASCADE',
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "document_pack_offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "eligible_plan_code" character varying(64),
        "documents_granted" integer NOT NULL,
        "stripe_price_id" character varying NOT NULL,
        "stripe_product_id" character varying,
        "name" character varying(120),
        "amount" integer NOT NULL,
        "currency" character varying(3) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_pack_offers" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_document_pack_offers_documents" CHECK ("documents_granted" > 0),
        CONSTRAINT "CHK_document_pack_offers_amount" CHECK ("amount" >= 0)
      )
    `);
    await this.addUniqueIfMissing(
      queryRunner,
      'document_pack_offers',
      'UQ_document_pack_offers_stripe_price_id',
      'stripe_price_id',
    );
    await this.addUniqueIfMissing(
      queryRunner,
      'document_pack_offers',
      'UQ_document_pack_offers_stripe_product_id',
      'stripe_product_id',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'document_pack_offers',
      'FK_document_pack_offers_plan',
      'eligible_plan_code',
      '"plans"("code") ON DELETE CASCADE',
    );

    /**
     * `CHK_billing_profiles_exactly_one_owner` es la regla que sostiene todo el módulo: un perfil
     * pertenece a una cuenta personal O a una organización, nunca a las dos ni a ninguna. Vive en
     * la base y no sólo en el código porque es lo que impide que un `INSERT` manual —una
     * corrección en caliente, un script de migración de datos— deje un perfil sin dueño o con
     * dos, que es exactamente el estado en el que el saldo de documentos deja de tener sentido.
     */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "personal_account_id" uuid,
        "organization_id" uuid,
        "current_plan_code" character varying,
        "stripe_customer_id" character varying,
        "stripe_subscription_id" character varying,
        "status" "public"."billing_profiles_status_enum" NOT NULL DEFAULT 'INCOMPLETE',
        "current_period_start" TIMESTAMP WITH TIME ZONE,
        "current_period_end" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_billing_profiles_exactly_one_owner" CHECK (
          ("personal_account_id" IS NOT NULL AND "organization_id" IS NULL)
          OR ("personal_account_id" IS NULL AND "organization_id" IS NOT NULL)
        )
      )
    `);
    for (const [constraint, column] of [
      ['UQ_billing_profiles_personal_account', 'personal_account_id'],
      ['UQ_billing_profiles_organization', 'organization_id'],
      ['UQ_billing_profiles_stripe_customer', 'stripe_customer_id'],
      ['UQ_billing_profiles_stripe_subscription', 'stripe_subscription_id'],
    ]) {
      await this.addUniqueIfMissing(
        queryRunner,
        'billing_profiles',
        constraint,
        column,
      );
    }
    await this.addForeignKeyIfMissing(
      queryRunner,
      'billing_profiles',
      'FK_billing_profiles_personal_account',
      'personal_account_id',
      '"accounts"("id") ON DELETE CASCADE',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'billing_profiles',
      'FK_billing_profiles_organization',
      'organization_id',
      '"organizations"("id") ON DELETE CASCADE',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'billing_profiles',
      'FK_billing_profiles_current_plan',
      'current_plan_code',
      '"plans"("code") ON DELETE SET NULL',
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "checkout_orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "plan_price_id" uuid,
        "document_pack_offer_id" uuid,
        "kind" "public"."checkout_orders_kind_enum" NOT NULL,
        "stripe_checkout_session_id" character varying NOT NULL,
        "stripe_payment_intent_id" character varying,
        "status" "public"."checkout_orders_status_enum" NOT NULL DEFAULT 'PENDING',
        "amount" integer NOT NULL,
        "currency" character varying(3) NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_checkout_orders" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_checkout_orders_amount" CHECK ("amount" >= 0),
        CONSTRAINT "CHK_checkout_orders_item_matches_kind" CHECK (
          ("kind" = 'SUBSCRIPTION' AND "plan_price_id" IS NOT NULL AND "document_pack_offer_id" IS NULL)
          OR ("kind" = 'ADD_ON' AND "plan_price_id" IS NULL AND "document_pack_offer_id" IS NOT NULL)
        )
      )
    `);
    await this.addUniqueIfMissing(
      queryRunner,
      'checkout_orders',
      'UQ_checkout_orders_session',
      'stripe_checkout_session_id',
    );
    await this.addUniqueIfMissing(
      queryRunner,
      'checkout_orders',
      'UQ_checkout_orders_payment_intent',
      'stripe_payment_intent_id',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'checkout_orders',
      'FK_checkout_orders_billing_profile',
      'billing_profile_id',
      '"billing_profiles"("id") ON DELETE CASCADE',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'checkout_orders',
      'FK_checkout_orders_plan_price',
      'plan_price_id',
      '"plan_prices"("id") ON DELETE RESTRICT',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'checkout_orders',
      'FK_checkout_orders_document_pack_offer',
      'document_pack_offer_id',
      '"document_pack_offers"("id") ON DELETE RESTRICT',
    );

    /**
     * `UQ_credit_lots_stripe_invoice` no es sólo higiene: es la red final de la idempotencia del
     * `invoice.paid`. `SubscriptionBillingService` ya comprueba y bloquea el perfil antes de
     * emitir, pero si esa comprobación fallara —dos procesos, un despliegue a medias— este índice
     * convierte "regalar un mes de documentos por duplicado" en un error de escritura.
     */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "credit_lots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "checkout_order_id" uuid,
        "origin" "public"."credit_lots_origin_enum" NOT NULL,
        "issued" integer NOT NULL,
        "remaining" integer NOT NULL,
        "priority" integer NOT NULL DEFAULT 0,
        "stripe_invoice_id" character varying,
        "stripe_payment_intent_id" character varying,
        "period_start" TIMESTAMP WITH TIME ZONE,
        "period_end" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_lots" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_credit_lots_issued" CHECK ("issued" > 0),
        CONSTRAINT "CHK_credit_lots_remaining" CHECK ("remaining" >= 0 AND "remaining" <= "issued")
      )
    `);
    for (const [constraint, column] of [
      ['UQ_credit_lots_checkout_order', 'checkout_order_id'],
      ['UQ_credit_lots_stripe_invoice', 'stripe_invoice_id'],
      ['UQ_credit_lots_stripe_payment_intent', 'stripe_payment_intent_id'],
    ]) {
      await this.addUniqueIfMissing(
        queryRunner,
        'credit_lots',
        constraint,
        column,
      );
    }
    await this.addForeignKeyIfMissing(
      queryRunner,
      'credit_lots',
      'FK_credit_lots_billing_profile',
      'billing_profile_id',
      '"billing_profiles"("id") ON DELETE CASCADE',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'credit_lots',
      'FK_credit_lots_checkout_order',
      'checkout_order_id',
      '"checkout_orders"("id") ON DELETE SET NULL',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_credit_lots_consumption" ON "credit_lots" ("billing_profile_id", "origin", "remaining", "period_end")',
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "document_credit_consumptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "credit_lot_id" uuid NOT NULL,
        "units" integer NOT NULL DEFAULT 1,
        "signature_type" "public"."document_credit_consumptions_signature_type_enum" NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reversed_at" TIMESTAMP WITH TIME ZONE,
        "reason" text,
        CONSTRAINT "PK_document_credit_consumptions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_document_credit_consumptions_units" CHECK ("units" = 1)
      )
    `);
    await this.addUniqueIfMissing(
      queryRunner,
      'document_credit_consumptions',
      'UQ_document_credit_consumptions_document',
      'document_id',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'document_credit_consumptions',
      'FK_document_credit_consumptions_document',
      'document_id',
      '"documents"("id") ON DELETE RESTRICT',
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'document_credit_consumptions',
      'FK_document_credit_consumptions_credit_lot',
      'credit_lot_id',
      '"credit_lots"("id") ON DELETE RESTRICT',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Orden inverso al de creación, por las llaves foráneas. `plans`, `plan_prices` y
     * `document_pack_offers` NO se borran: existían antes de esta migración (las creó
     * `synchronize`), así que revertirla no debería llevárselas por delante junto con el catálogo
     * comercial cargado.
     */
    await queryRunner.query(
      'DROP TABLE IF EXISTS "document_credit_consumptions"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "credit_lots"');
    await queryRunner.query('DROP TABLE IF EXISTS "checkout_orders"');
    await queryRunner.query('DROP TABLE IF EXISTS "billing_profiles"');

    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."document_credit_consumptions_signature_type_enum"',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."credit_lots_origin_enum"',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."checkout_orders_status_enum"',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."checkout_orders_kind_enum"',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS "public"."billing_profiles_status_enum"',
    );
  }

  /**
   * `CREATE TYPE` no admite `IF NOT EXISTS` en Postgres, así que se consulta `pg_type` primero.
   * Los nombres siguen la convención que genera TypeORM (`{tabla}_{columna}_enum`) para que
   * `synchronize` y esta migración describan exactamente el mismo tipo y no se peleen.
   */
  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    const enums: Array<[string, string[]]> = [
      ['plan_prices_interval_enum', ['MONTH', 'YEAR']],
      [
        'billing_profiles_status_enum',
        ['INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED'],
      ],
      ['checkout_orders_kind_enum', ['SUBSCRIPTION', 'ADD_ON']],
      [
        'checkout_orders_status_enum',
        ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'],
      ],
      [
        'credit_lots_origin_enum',
        ['CURRENT_PERIOD', 'ROLLOVER', 'ADD_ON'],
      ],
      [
        'document_credit_consumptions_signature_type_enum',
        ['SIMPLE', 'ADVANCED'],
      ],
    ];

    for (const [name, values] of enums) {
      const [{ exists }] = await queryRunner.query(
        'SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = $1) AS "exists"',
        [name],
      );

      if (!exists) {
        const literals = values.map((value) => `'${value}'`).join(', ');
        await queryRunner.query(
          `CREATE TYPE "public"."${name}" AS ENUM(${literals})`,
        );
      }
    }
  }

  private async addUniqueIfMissing(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
    column: string,
  ): Promise<void> {
    if (await this.constraintExists(queryRunner, table, constraint)) {
      return;
    }

    /**
     * Un UNIQUE sobre columna nullable no estorba a las filas sin valor: Postgres no considera
     * iguales dos NULL en un índice único, así que varios perfiles sin `stripe_customer_id`
     * conviven sin chocar.
     */
    await queryRunner.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" UNIQUE ("${column}")`,
    );
  }

  private async addForeignKeyIfMissing(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
    column: string,
    references: string,
  ): Promise<void> {
    if (await this.constraintExists(queryRunner, table, constraint)) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" FOREIGN KEY ("${column}") REFERENCES ${references}`,
    );
  }

  private async constraintExists(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
  ): Promise<boolean> {
    const [{ exists }] = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = $1 AND c.conname = $2
       ) AS "exists"`,
      [table, constraint],
    );

    return exists;
  }
}
