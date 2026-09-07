import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra el plan gratuito y da de alta retroactivamente el `billing_profile` de los
 * propietarios que se crearon antes de que el perfil naciera con la cuenta.
 *
 * Depende de que `AddFreeBillingProfileStatus` (042) ya haya confirmado el valor `FREE` del
 * enum: por eso son dos migraciones y no una — ver el docblock de aquélla.
 *
 * El backfill no es opcional para que la historia se cumpla: sin él, "toda cuenta personal u
 * organización tiene un estado comercial local" valdría sólo para las que se den de alta a
 * partir de este despliegue, y las que ya existen seguirían respondiendo un estado vacío para
 * siempre. Nadie las volvería a crear para que el código nuevo las alcance.
 */
export class IntroduceFreeBillingProfiles1784300000043 implements MigrationInterface {
  name = 'IntroduceFreeBillingProfiles1784300000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `current_plan_type` es FK a `plans.plan_type`, así que la fila del plan tiene que existir
     * ANTES que cualquier perfil que la referencie. Mismo criterio que la migración del rol
     * MEMBER: se siembra acá en vez de confiar en que un seed manual se haya corrido.
     */
    await queryRunner.query(`
      INSERT INTO "plans" (
        "plan_type", "name", "is_active", "creation_source",
        "stripe_product_id", "catalog_item_id", "documents_included"
      )
      VALUES ('free', 'Plan Gratuito', true, 'MANUAL', NULL, NULL, 1)
      ON CONFLICT ("plan_type") DO NOTHING
    `);

    /**
     * Un perfil por cuenta PERSONAL activa que no lo tenga. `is_active` filtra las membresías
     * dadas de baja: facturarle a una cuenta revocada no tiene sentido y ensuciaría la tabla.
     */
    await queryRunner.query(`
      INSERT INTO "billing_profiles" (
        "personal_account_id", "organization_id", "current_plan_type", "status"
      )
      SELECT a."id", NULL, 'free', 'FREE'
      FROM "accounts" a
      WHERE a."account_type" = 'PERSONAL'
        AND a."is_active" = true
        AND NOT EXISTS (
          SELECT 1 FROM "billing_profiles" p WHERE p."personal_account_id" = a."id"
        )
    `);

    /**
     * Uno por ORGANIZACIÓN, no por miembro: el perfil lo comparte la organización entera, así
     * que se recorre `organizations` y no `accounts` — recorrer las membresías intentaría
     * insertar una fila por empleado y chocaría con el índice único de `organization_id`.
     */
    await queryRunner.query(`
      INSERT INTO "billing_profiles" (
        "personal_account_id", "organization_id", "current_plan_type", "status"
      )
      SELECT NULL, o."id", 'free', 'FREE'
      FROM "organizations" o
      WHERE NOT EXISTS (
        SELECT 1 FROM "billing_profiles" p WHERE p."organization_id" = o."id"
      )
    `);
  }

  /**
   * Se deshace sólo lo que esta migración sembró: los perfiles que siguen intactos en plan Free
   * y la fila del plan. Un perfil que ya pasó por Stripe (tiene cliente o suscripción) NO se
   * borra aunque lo hubiera creado este backfill — sería tirar el vínculo con un cobro real.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "billing_profiles"
      WHERE "status" = 'FREE'
        AND "current_plan_type" = 'free'
        AND "stripe_customer_id" IS NULL
        AND "stripe_subscription_id" IS NULL
    `);

    await queryRunner.query(
      `DELETE FROM "plans" WHERE "plan_type" = 'free' AND "creation_source" = 'MANUAL'`,
    );
  }
}
