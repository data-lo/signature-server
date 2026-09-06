import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `subscription_billing_history` y añade `billing_profiles.cancel_at_period_end`: lo que
 * hace falta para que el término definitivo de una suscripción deje rastro.
 *
 * **Las dos cosas van juntas porque describen el mismo ciclo.** `cancel_at_period_end` es la baja
 * PROGRAMADA —la suscripción sigue viva y pagada— y el historial es donde queda el término
 * CONSUMADO, con el plan que el cliente tuvo, cuándo acabó y por qué. Separarlas en dos
 * migraciones dejaría una base intermedia en la que el perfil puede anunciar un término que no
 * tiene dónde registrarse.
 *
 * **Qué problema resuelve el historial.** Al finalizar, el perfil vuelve al plan gratuito, así
 * que deja de poder responder qué tenía contratado antes. Sin esta tabla, la única forma de
 * saber que alguien pagó un `plus` durante ocho meses sería reconstruirlo desde los `credit_lots`
 * o desde el panel de Stripe.
 *
 * `IF NOT EXISTS` y los bloques `DO` mantienen la migración repetible sobre las bases de
 * desarrollo que ya hubieran levantado el esquema desde las entidades, igual que hace
 * `CreateBillingSchema`.
 */
export class CreateSubscriptionBillingHistory1784300000044 implements MigrationInterface {
  name = 'CreateSubscriptionBillingHistory1784300000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createEnums(queryRunner);

    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_billing_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "plan_type" character varying(64),
        "source" "public"."billing_source_enum" NOT NULL DEFAULT 'STRIPE',
        "status" "public"."subscription_billing_history_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "period_start" TIMESTAMP WITH TIME ZONE,
        "period_end" TIMESTAMP WITH TIME ZONE,
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "ended_reason" "public"."subscription_end_reason_enum",
        "stripe_customer_id" character varying,
        "stripe_subscription_id" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscription_billing_history" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_subscription_billing_history_plan"
          CHECK ("plan_type" IS NULL OR "plan_type" <> 'free'),
        CONSTRAINT "CHK_subscription_billing_history_ended" CHECK (
          ("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
          OR ("status" <> 'ACTIVE' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL)
        ),
        CONSTRAINT "FK_subscription_billing_history_profile"
          FOREIGN KEY ("billing_profile_id")
          REFERENCES "billing_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subscription_billing_history_plan"
          FOREIGN KEY ("plan_type")
          REFERENCES "plans"("plan_type") ON DELETE SET NULL
      )
    `);

    /**
     * La consulta natural es "el historial de este perfil, del más reciente al más viejo", y
     * `period_start` es el orden que tiene sentido comercial — no `created_at`, que ordenaría los
     * periodos por cuándo los registró el webhook en vez de por cuándo ocurrieron.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subscription_billing_history_profile"
      ON "subscription_billing_history" ("billing_profile_id", "period_start")
    `);

    /**
     * La llave con la que el webhook reconoce lo que ya registró. `customer.subscription.deleted`
     * llega más de una vez, y sin este índice cada reintento recorrería la tabla entera para
     * decidir si el cierre ya estaba escrito.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subscription_billing_history_stripe_subscription"
      ON "subscription_billing_history" ("stripe_subscription_id")
    `);
  }

  /**
   * Se borra la tabla entera y la columna: nacen acá y nadie las escribía antes, así que revertir
   * no puede perder un dato que existiera de otra fuente. Los `credit_lots` y los
   * `checkout_orders` a los que acompaña NO se tocan — el saldo que el cliente compró es suyo con
   * historial o sin él.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "subscription_billing_history"`,
    );
    await queryRunner.query(
      `ALTER TABLE "billing_profiles" DROP COLUMN IF EXISTS "cancel_at_period_end"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."subscription_end_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."subscription_billing_history_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."billing_source_enum"`,
    );
  }

  /**
   * `CREATE TYPE` no admite `IF NOT EXISTS` en ninguna versión de Postgres, así que la
   * idempotencia se consigue atrapando `duplicate_object`.
   *
   * Los tres tipos se crean y se usan en la MISMA transacción, y eso sí se puede: la restricción
   * que obligó a partir en dos `AddFreeBillingProfileStatus` (55P04) aplica a los valores
   * AÑADIDOS a un enum que ya existía, no a un tipo nacido en esta transacción.
   */
  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    const enums: [string, string[]][] = [
      ['billing_source_enum', ['STRIPE', 'MANUAL']],
      [
        'subscription_billing_history_status_enum',
        ['ACTIVE', 'CANCELED', 'EXPIRED'],
      ],
      [
        'subscription_end_reason_enum',
        ['CANCELED_AT_PERIOD_END', 'PAYMENT_FAILURE', 'STRIPE_TERMINATED'],
      ],
    ];

    for (const [name, values] of enums) {
      const literals = values.map((value) => `'${value}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "public"."${name}" AS ENUM (${literals});
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END $$;
      `);
    }
  }
}
