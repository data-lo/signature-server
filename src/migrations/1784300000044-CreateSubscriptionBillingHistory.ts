import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `subscription_billing_history`: un renglón por periodo de suscripción pagado, venga el
 * cobro de Stripe o de una factura emitida a mano.
 *
 * **Qué problema resuelve.** Hasta ahora el único rastro de un cobro recurrente eran el
 * `credit_lot` que emitió y el `billing_profile`, y ninguno de los dos guarda historia: el perfil
 * representa el estado VIGENTE y cada renovación lo pisa, así que el plan y el periodo anteriores
 * desaparecían. Con esta tabla el perfil puede seguir siendo una sola fila trivial —lo que está
 * activo hoy— mientras el registro de qué se cobró, cuándo, por cuánto y quién lo cobró vive
 * aparte y no se sobrescribe nunca.
 *
 * **Los índices únicos son la idempotencia, no una optimización.** `stripe_invoice_id` impide que
 * una re-entrega del webhook (Stripe reintenta durante días) acredite documentos dos veces;
 * `UQ_..._manual_reference` impide lo mismo cuando quien reenvía es una persona capturando la
 * misma transferencia. El código los comprueba antes, pero es la base la que lo garantiza.
 *
 * `IF NOT EXISTS` y el bloque `DO` del tipo mantienen la migración repetible sobre las bases de
 * desarrollo que ya hubieran levantado el esquema desde las entidades, igual que hace
 * `CreateBillingSchema`.
 */
export class CreateSubscriptionBillingHistory1784300000044 implements MigrationInterface {
  name = 'CreateSubscriptionBillingHistory1784300000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `CREATE TYPE` no admite `IF NOT EXISTS` en ninguna versión de Postgres, así que la
     * idempotencia se consigue atrapando `duplicate_object`.
     *
     * El tipo se crea y se usa en la MISMA transacción, y eso sí se puede: la restricción de
     * Postgres que obligó a partir en dos `AddFreeBillingProfileStatus` (55P04) aplica a los
     * valores AÑADIDOS a un enum que ya existía, no a un tipo nacido en esta transacción.
     */
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."billing_source_enum" AS ENUM ('STRIPE', 'MANUAL');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_billing_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "checkout_order_id" uuid,
        "credit_slot_id" uuid,
        "source" "public"."billing_source_enum" NOT NULL,
        "plan_type" character varying(64) NOT NULL,
        "amount" integer NOT NULL,
        "currency" character varying(3) NOT NULL,
        "period_start" TIMESTAMP WITH TIME ZONE NOT NULL,
        "period_end" TIMESTAMP WITH TIME ZONE NOT NULL,
        "paid_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "stripe_customer_id" character varying,
        "stripe_subscription_id" character varying,
        "stripe_invoice_id" character varying,
        "stripe_payment_intent_id" character varying,
        "external_reference" character varying,
        "created_by_user_id" uuid,
        "notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscription_billing_history" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subscription_billing_history_stripe_invoice" UNIQUE ("stripe_invoice_id"),
        CONSTRAINT "UQ_subscription_billing_history_credit_slot" UNIQUE ("credit_slot_id"),
        CONSTRAINT "CHK_subscription_billing_history_amount" CHECK ("amount" >= 0),
        CONSTRAINT "CHK_subscription_billing_history_period" CHECK ("period_start" < "period_end"),
        CONSTRAINT "CHK_subscription_billing_history_origin_evidence" CHECK (
          ("source" = 'STRIPE' AND "stripe_invoice_id" IS NOT NULL)
          OR ("source" = 'MANUAL' AND ("external_reference" IS NOT NULL OR "created_by_user_id" IS NOT NULL))
        ),
        CONSTRAINT "FK_subscription_billing_history_profile"
          FOREIGN KEY ("billing_profile_id")
          REFERENCES "billing_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subscription_billing_history_checkout_order"
          FOREIGN KEY ("checkout_order_id")
          REFERENCES "checkout_orders"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_subscription_billing_history_credit_slot"
          FOREIGN KEY ("credit_slot_id")
          REFERENCES "credit_lots"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_subscription_billing_history_plan"
          FOREIGN KEY ("plan_type")
          REFERENCES "plans"("plan_type") ON DELETE RESTRICT,
        CONSTRAINT "FK_subscription_billing_history_created_by"
          FOREIGN KEY ("created_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    /**
     * La consulta natural de la tabla es "el historial de este perfil, del más reciente al más
     * viejo", y `period_start` es el orden que tiene sentido comercial — no `created_at`, que en
     * una factura manual capturada con retraso ordenaría los periodos por cuándo los tecleó
     * administración en vez de por cuándo ocurrieron.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subscription_billing_history_profile"
      ON "subscription_billing_history" ("billing_profile_id", "period_start")
    `);

    /**
     * La clave natural del cobro manual: una referencia no se registra dos veces para el mismo
     * perfil. Parcial porque los periodos de Stripe ya se desduplican por `stripe_invoice_id` y
     * porque un folio nulo —todos los de Stripe lo son— no debe competir por la unicidad.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscription_billing_history_manual_reference"
      ON "subscription_billing_history" ("billing_profile_id", "external_reference")
      WHERE "source" = 'MANUAL' AND "external_reference" IS NOT NULL
    `);
  }

  /**
   * Se borra la tabla entera: nace acá y nadie la escribía antes, así que revertir no puede
   * perder un dato que existiera de otra fuente. Los `credit_lots` y los `checkout_orders` a los
   * que apuntaba NO se tocan — el saldo que el cliente compró es suyo con historial o sin él.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "subscription_billing_history"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."billing_source_enum"`,
    );
  }
}
