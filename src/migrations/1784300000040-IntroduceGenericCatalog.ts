import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separa el producto comercial de su precio y reemplaza las dos rutas polimórficas de checkout
 * por un catálogo genérico. No borra las tablas heredadas: permanecen como evidencia de órdenes
 * anteriores mientras checkout_orders ya queda enlazado a catalog_prices.
 */
export class IntroduceGenericCatalog1784300000040 implements MigrationInterface {
  name = 'IntroduceGenericCatalog1784300000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createEnums(queryRunner);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "catalog_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "item_type" "public"."catalog_items_item_type_enum" NOT NULL,
        "source" "public"."catalog_items_source_enum" NOT NULL,
        "name" character varying(120) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "stripe_product_id" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_items" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_catalog_items_stripe_product" ON "catalog_items" ("stripe_product_id")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_catalog_items_stripe_product_type" ON "catalog_items" ("stripe_product_id", "item_type")',
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "document_credit_packs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "catalog_item_id" uuid NOT NULL,
        "documents_granted" integer NOT NULL,
        CONSTRAINT "PK_document_credit_packs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_document_credit_packs_catalog_item" UNIQUE ("catalog_item_id"),
        CONSTRAINT "CHK_document_credit_packs_documents" CHECK ("documents_granted" > 0),
        CONSTRAINT "FK_document_credit_packs_catalog_item"
          FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "catalog_item_scopes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "catalog_item_id" uuid NOT NULL,
        "subject_type" "public"."catalog_item_scopes_subject_type_enum" NOT NULL,
        "subject_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_item_scopes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_catalog_item_scopes_subject"
          UNIQUE ("catalog_item_id", "subject_type", "subject_id"),
        CONSTRAINT "FK_catalog_item_scopes_catalog_item"
          FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "catalog_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "catalog_item_id" uuid NOT NULL,
        "eligible_plan_type" character varying(64),
        "source" "public"."catalog_prices_source_enum" NOT NULL,
        "stripe_price_id" character varying,
        "amount" integer NOT NULL,
        "currency" character varying(3) NOT NULL,
        "billing_mode" "public"."catalog_prices_billing_mode_enum" NOT NULL,
        "interval" "public"."catalog_prices_interval_enum",
        "interval_count" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "effective_from" TIMESTAMP WITH TIME ZONE,
        "effective_to" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_prices" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_catalog_prices_amount" CHECK ("amount" >= 0),
        CONSTRAINT "CHK_catalog_prices_recurrence" CHECK (
          ("billing_mode" = 'ONE_TIME' AND "interval" IS NULL AND "interval_count" IS NULL)
          OR
          ("billing_mode" = 'RECURRING' AND "interval" IS NOT NULL AND "interval_count" > 0)
        ),
        CONSTRAINT "FK_catalog_prices_catalog_item"
          FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_catalog_prices_eligible_plan"
          FOREIGN KEY ("eligible_plan_type") REFERENCES "plans"("plan_type") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_catalog_prices_stripe_price" ON "catalog_prices" ("stripe_price_id")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_catalog_prices_sellable" ON "catalog_prices" ("catalog_item_id", "is_active", "effective_from")',
    );

    await queryRunner.query(
      'ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "catalog_item_id" uuid',
    );
    await this.backfillPlans(queryRunner);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_plans_catalog_item_id'
        ) THEN
          ALTER TABLE "plans" ADD CONSTRAINT "UQ_plans_catalog_item_id" UNIQUE ("catalog_item_id");
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_plans_catalog_item'
        ) THEN
          ALTER TABLE "plans" ADD CONSTRAINT "FK_plans_catalog_item"
            FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await this.backfillLegacyPrices(queryRunner);

    // El slot identifica el periodo de una suscripción incluso si el perfil cambia de plan más
    // adelante. Así podemos enlazar de forma precisa la orden de Checkout con el saldo emitido.
    await queryRunner.query(
      'ALTER TABLE "credit_lots" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" character varying',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_credit_lots_stripe_subscription" ON "credit_lots" ("stripe_subscription_id")',
    );
    await queryRunner.query(`
      UPDATE "credit_lots" cl
      SET "stripe_subscription_id" = bp."stripe_subscription_id"
      FROM "billing_profiles" bp
      WHERE bp."id" = cl."billing_profile_id"
        AND cl."stripe_subscription_id" IS NULL
        AND bp."stripe_subscription_id" IS NOT NULL
    `);

    await queryRunner.query(
      'ALTER TABLE "checkout_orders" ADD COLUMN IF NOT EXISTS "catalog_price_id" uuid',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" ADD COLUMN IF NOT EXISTS "credit_slot_id" uuid',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" character varying',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_checkout_orders_stripe_subscription" ON "checkout_orders" ("stripe_subscription_id")',
    );
    await this.backfillCheckoutOrders(queryRunner);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "checkout_orders" WHERE "catalog_price_id" IS NULL
        ) THEN
          RAISE EXCEPTION 'No se pudo migrar alguna checkout_order a catalog_price_id';
        END IF;
      END $$;
    `);
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" ALTER COLUMN "catalog_price_id" SET NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" DROP CONSTRAINT IF EXISTS "CHK_checkout_orders_item_matches_kind"',
    );
    await queryRunner.query(
      'ALTER TABLE "checkout_orders" ADD CONSTRAINT "CHK_checkout_orders_catalog_price" CHECK ("catalog_price_id" IS NOT NULL)',
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_checkout_orders_catalog_price'
        ) THEN
          ALTER TABLE "checkout_orders" ADD CONSTRAINT "FK_checkout_orders_catalog_price"
            FOREIGN KEY ("catalog_price_id") REFERENCES "catalog_prices"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_checkout_orders_credit_slot'
        ) THEN
          ALTER TABLE "checkout_orders" ADD CONSTRAINT "FK_checkout_orders_credit_slot"
            FOREIGN KEY ("credit_slot_id") REFERENCES "credit_lots"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // La relación se invierte: muchas órdenes pueden acreditar el mismo slot de periodo.
    await queryRunner.query(
      'ALTER TABLE "credit_lots" DROP CONSTRAINT IF EXISTS "FK_credit_lots_checkout_order"',
    );
    await this.dropUniqueConstraintsForColumn(
      queryRunner,
      'credit_lots',
      'checkout_order_id',
    );
    await queryRunner.query(
      'ALTER TABLE "credit_lots" DROP COLUMN IF EXISTS "checkout_order_id"',
    );
  }

  /** El rollback perdería precios/ítems manuales creados después de esta migración. */
  public async down(): Promise<void> {
    throw new Error(
      'IntroduceGenericCatalog no se revierte automáticamente: contiene datos comerciales y órdenes históricas.',
    );
  }

  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    const enums: Array<[string, string[]]> = [
      ['catalog_items_item_type_enum', ['PLAN', 'DOCUMENT_CREDIT']],
      ['catalog_items_source_enum', ['MANUAL', 'STRIPE']],
      ['catalog_prices_source_enum', ['MANUAL', 'STRIPE']],
      ['catalog_prices_billing_mode_enum', ['ONE_TIME', 'RECURRING']],
      ['catalog_prices_interval_enum', ['MONTH', 'YEAR']],
      [
        'catalog_item_scopes_subject_type_enum',
        ['ORGANIZATION', 'PERSONAL_ACCOUNT'],
      ],
    ];

    for (const [name, values] of enums) {
      const literals = values.map((value) => `'${value}'`).join(', ');
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN
            CREATE TYPE "public"."${name}" AS ENUM (${literals});
          END IF;
        END $$;
      `);
    }
  }

  private async backfillPlans(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TEMP TABLE "plan_catalog_item_map" ON COMMIT DROP AS
      SELECT "plan_type", uuid_generate_v4() AS "catalog_item_id"
      FROM "plans"
      WHERE "catalog_item_id" IS NULL
    `);
    await queryRunner.query(`
      INSERT INTO "catalog_items" (
        "id", "item_type", "source", "name", "is_active", "stripe_product_id"
      )
      SELECT
        m."catalog_item_id",
        'PLAN'::"public"."catalog_items_item_type_enum",
        CASE WHEN p."creation_source" = 'STRIPE'
          THEN 'STRIPE'::"public"."catalog_items_source_enum"
          ELSE 'MANUAL'::"public"."catalog_items_source_enum"
        END,
        p."name",
        p."is_active",
        p."stripe_product_id"
      FROM "plan_catalog_item_map" m
      INNER JOIN "plans" p ON p."plan_type" = m."plan_type"
    `);
    await queryRunner.query(`
      UPDATE "plans" p
      SET "catalog_item_id" = m."catalog_item_id"
      FROM "plan_catalog_item_map" m
      WHERE p."plan_type" = m."plan_type"
    `);
  }

  private async backfillLegacyPrices(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TEMP TABLE "plan_price_catalog_map" ON COMMIT DROP AS
      SELECT pp."id" AS "legacy_id", uuid_generate_v4() AS "catalog_price_id"
      FROM "plan_prices" pp
    `);
    await queryRunner.query(`
      INSERT INTO "catalog_prices" (
        "id", "catalog_item_id", "source", "stripe_price_id", "amount", "currency",
        "billing_mode", "interval", "interval_count", "is_active", "effective_from", "effective_to"
      )
      SELECT
        m."catalog_price_id", p."catalog_item_id",
        'STRIPE'::"public"."catalog_prices_source_enum",
        pp."stripe_price_id", pp."amount", pp."currency",
        'RECURRING'::"public"."catalog_prices_billing_mode_enum",
        pp."interval"::text::"public"."catalog_prices_interval_enum", pp."interval_count",
        pp."is_active", pp."effective_from", pp."effective_to"
      FROM "plan_price_catalog_map" m
      INNER JOIN "plan_prices" pp ON pp."id" = m."legacy_id"
      INNER JOIN "plans" p ON p."plan_type" = pp."plan_type"
    `);

    await queryRunner.query(`
      CREATE TEMP TABLE "pack_offer_catalog_map" ON COMMIT DROP AS
      SELECT o."id" AS "legacy_id", uuid_generate_v4() AS "catalog_item_id", uuid_generate_v4() AS "catalog_price_id"
      FROM "document_pack_offers" o
    `);
    await queryRunner.query(`
      INSERT INTO "catalog_items" (
        "id", "item_type", "source", "name", "is_active", "stripe_product_id"
      )
      SELECT
        m."catalog_item_id",
        'DOCUMENT_CREDIT'::"public"."catalog_items_item_type_enum",
        'STRIPE'::"public"."catalog_items_source_enum",
        COALESCE(o."name", 'Paquete de documentos'),
        o."active",
        o."stripe_product_id"
      FROM "pack_offer_catalog_map" m
      INNER JOIN "document_pack_offers" o ON o."id" = m."legacy_id"
    `);
    await queryRunner.query(`
      INSERT INTO "document_credit_packs" ("catalog_item_id", "documents_granted")
      SELECT m."catalog_item_id", o."documents_granted"
      FROM "pack_offer_catalog_map" m
      INNER JOIN "document_pack_offers" o ON o."id" = m."legacy_id"
    `);
    await queryRunner.query(`
      INSERT INTO "catalog_prices" (
        "id", "catalog_item_id", "eligible_plan_type", "source", "stripe_price_id",
        "amount", "currency", "billing_mode", "is_active", "effective_from", "effective_to"
      )
      SELECT
        m."catalog_price_id", m."catalog_item_id", o."eligible_plan_type",
        'STRIPE'::"public"."catalog_prices_source_enum", o."stripe_price_id",
        o."amount", o."currency", 'ONE_TIME'::"public"."catalog_prices_billing_mode_enum",
        o."active", o."created_at", NULL
      FROM "pack_offer_catalog_map" m
      INNER JOIN "document_pack_offers" o ON o."id" = m."legacy_id"
    `);
  }

  private async backfillCheckoutOrders(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      UPDATE "checkout_orders" o
      SET "catalog_price_id" = m."catalog_price_id"
      FROM "plan_price_catalog_map" m
      WHERE o."plan_price_id" = m."legacy_id"
        AND o."catalog_price_id" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "checkout_orders" o
      SET "catalog_price_id" = m."catalog_price_id"
      FROM "pack_offer_catalog_map" m
      WHERE o."document_pack_offer_id" = m."legacy_id"
        AND o."catalog_price_id" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "checkout_orders" o
      SET "credit_slot_id" = cl."id"
      FROM "credit_lots" cl
      WHERE cl."checkout_order_id" = o."id"
        AND o."credit_slot_id" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "checkout_orders" o
      SET "stripe_subscription_id" = bp."stripe_subscription_id"
      FROM "billing_profiles" bp
      WHERE bp."id" = o."billing_profile_id"
        AND o."stripe_subscription_id" IS NULL
        AND bp."stripe_subscription_id" IS NOT NULL
        AND o."kind" = 'SUBSCRIPTION'
    `);
  }

  private async dropUniqueConstraintsForColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE constraint_name text;
      BEGIN
        FOR constraint_name IN
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          INNER JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
          WHERE tc.table_schema = 'public'
            AND tc.table_name = '${table}'
            AND tc.constraint_type = 'UNIQUE'
            AND kcu.column_name = '${column}'
        LOOP
          EXECUTE format('ALTER TABLE "${table}" DROP CONSTRAINT %I', constraint_name);
        END LOOP;
      END $$;
    `);
  }
}
