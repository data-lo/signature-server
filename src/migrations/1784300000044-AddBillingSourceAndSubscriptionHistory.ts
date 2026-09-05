import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduce el ORIGEN de la facturación: `billing_profiles.billing_source` y la tabla
 * `subscription_billing_history`, que guarda un renglón por periodo facturado.
 *
 * **El problema que resuelve.** Hasta ahora el único indicio de quién controlaba una suscripción
 * era la presencia de `stripe_subscription_id`, y eso no distingue a un perfil que Stripe
 * gobierna de uno facturado a mano que conserva ids del proveedor de una etapa anterior. La
 * diferencia importa porque los dos casos se vencen de forma opuesta: al de Stripe lo mueven los
 * webhooks, y al manual no lo mueve nadie hasta que un cron lo devuelve a Free
 * (`ExpireManualSubscriptionsJob`). `plan_type` tampoco sirve para distinguirlos: dice qué
 * beneficios hay (`free`, `basic`, `plus`), no quién los administra.
 *
 * **Va todo en una sola migración, y sí puede.** La restricción de Postgres que obligó a partir
 * en dos `AddFreeBillingProfileStatus` (55P04) aplica a los valores AÑADIDOS a un enum que ya
 * existía; un tipo creado dentro de esta misma transacción puede usarse en ella sin esperar al
 * commit. Los tres enums de acá son nuevos, así que no hace falta el `transaction = false`.
 *
 * `IF NOT EXISTS` y el bloque `DO` de los tipos mantienen la migración repetible sobre las bases
 * de desarrollo que ya hubieran levantado el esquema desde las entidades, igual que hace
 * `CreateBillingSchema`.
 */
export class AddBillingSourceAndSubscriptionHistory1784300000044 implements MigrationInterface {
  name = 'AddBillingSourceAndSubscriptionHistory1784300000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createEnums(queryRunner);

    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      ADD COLUMN IF NOT EXISTS "billing_source" "public"."billing_source_enum" NOT NULL DEFAULT 'FREE'
    `);

    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false
    `);

    /**
     * Backfill deliberadamente ancho: cualquier perfil que haya llegado a tocar Stripe —aunque
     * sólo tenga cliente porque abrió un checkout que no se cobró— se marca `STRIPE`.
     *
     * El sesgo es intencional y va hacia el lado seguro. `MANUAL` es el ÚNICO valor que pone un
     * perfil al alcance del cron, así que dejar de más en `STRIPE` o `FREE` no puede degradar a
     * nadie; equivocarse al revés sí. Y como la facturación manual no existía antes de esta
     * migración, ningún perfil histórico puede ser legítimamente `MANUAL`: el resto se queda con
     * el `FREE` por defecto.
     */
    await queryRunner.query(`
      UPDATE "billing_profiles"
      SET "billing_source" = 'STRIPE'
      WHERE "stripe_subscription_id" IS NOT NULL
         OR "stripe_customer_id" IS NOT NULL
    `);

    /**
     * Índice PARCIAL, no completo, porque la consulta del cron sólo mira una esquina de la tabla:
     * los perfiles manuales activos. Un índice sobre las tres columnas indexaría también los
     * perfiles Free —que son la inmensa mayoría y no se van a leer nunca por aquí—; éste ocupa lo
     * que ocupen los manuales vigentes y responde exactamente la pregunta que se le hace cada
     * cinco minutos.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_profiles_manual_expiry"
      ON "billing_profiles" ("current_period_end")
      WHERE "billing_source" = 'MANUAL' AND "status" = 'ACTIVE'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_billing_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "plan_type" character varying(64),
        "source" "public"."billing_source_enum" NOT NULL,
        "status" "public"."subscription_billing_history_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "period_start" TIMESTAMP WITH TIME ZONE,
        "period_end" TIMESTAMP WITH TIME ZONE,
        "stripe_invoice_id" character varying,
        "stripe_subscription_id" character varying,
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "ended_reason" "public"."billing_period_end_reason_enum",
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscription_billing_history" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subscription_billing_history_stripe_invoice" UNIQUE ("stripe_invoice_id"),
        CONSTRAINT "CHK_subscription_billing_history_source"
          CHECK ("source" IN ('STRIPE', 'MANUAL')),
        CONSTRAINT "CHK_subscription_billing_history_ended" CHECK (
          ("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
          OR ("status" = 'EXPIRED' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL)
        ),
        CONSTRAINT "FK_subscription_billing_history_profile"
          FOREIGN KEY ("billing_profile_id")
          REFERENCES "billing_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subscription_billing_history_plan"
          FOREIGN KEY ("plan_type")
          REFERENCES "plans"("plan_type") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subscription_billing_history_profile"
      ON "subscription_billing_history" ("billing_profile_id", "created_at")
    `);

    /**
     * La invariante entera del historial en una línea: **como mucho un periodo vigente por
     * perfil**.
     *
     * Sin ella, "el periodo activo" sería un conjunto que habría que desempatar por fecha, y dos
     * entregas simultáneas del mismo cobro —Stripe reintenta— podrían dejar dos periodos vivos
     * que ningún lector sabría reconciliar. Con ella, abrir un periodo obliga a cerrar el
     * anterior en la misma transacción, y el motor rechaza cualquier camino que se salte esa
     * regla aunque el código lo intente.
     *
     * Parcial (`WHERE status = 'ACTIVE'`) porque los periodos cerrados sí se acumulan sin
     * límite: un perfil con cinco años de historia tiene sesenta filas `EXPIRED` y ninguna de
     * ellas debe competir por la unicidad.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscription_billing_history_active"
      ON "subscription_billing_history" ("billing_profile_id")
      WHERE "status" = 'ACTIVE'
    `);
  }

  /**
   * Se deshace todo lo que esta migración creó, historial incluido: la tabla nace aquí y nadie
   * la escribía antes, así que revertir no puede borrar un dato que existiera de otra fuente.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "subscription_billing_history"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_billing_profiles_manual_expiry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "billing_profiles" DROP COLUMN IF EXISTS "cancel_at_period_end"`,
    );
    await queryRunner.query(
      `ALTER TABLE "billing_profiles" DROP COLUMN IF EXISTS "billing_source"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."billing_period_end_reason_enum"`,
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
   * idempotencia se consigue atrapando `duplicate_object`. Hace falta por lo mismo que en
   * `CreateBillingSchema`: las bases que ya levantaron el esquema desde las entidades pueden
   * tener los tipos puestos, y una migración que lo diera por imposible fallaría justo ahí.
   */
  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    const enums: [string, string[]][] = [
      ['billing_source_enum', ['STRIPE', 'MANUAL', 'FREE']],
      ['subscription_billing_history_status_enum', ['ACTIVE', 'EXPIRED']],
      ['billing_period_end_reason_enum', ['MANUAL_PERIOD_ENDED', 'RENEWED']],
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
