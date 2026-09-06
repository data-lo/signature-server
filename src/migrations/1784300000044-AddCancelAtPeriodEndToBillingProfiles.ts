import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `billing_profiles.cancel_at_period_end`: la baja PROGRAMADA de una suscripción que sigue
 * vigente.
 *
 * **Por qué una columna y no un estado más.** Un perfil con la baja programada habilita
 * exactamente lo mismo que uno sin ella —el periodo ya está pagado— y lo único que cambia es que
 * no se renovará. Meterlo en `billing_profiles_status_enum` obligaría a cada lectura de "¿puede
 * firmar?" a conocer el valor nuevo, y la que se olvidara le quitaría a un cliente un mes que ya
 * pagó. Como columna aparte, todo el código que hoy pregunta por `ACTIVE` sigue siendo correcto
 * sin tocarlo.
 *
 * `DEFAULT false` cubre el backfill sin escribir una sola fila: ningún perfil existente tiene una
 * baja programada, porque hasta ahora no había forma de pedirla.
 */
export class AddCancelAtPeriodEndToBillingProfiles1784300000044 implements MigrationInterface {
  name = 'AddCancelAtPeriodEndToBillingProfiles1784300000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `IF NOT EXISTS` deja la migración repetible: en una base de desarrollo que ya levantó el
     * esquema desde las entidades, la columna puede estar puesta desde antes.
     */
    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      DROP COLUMN IF EXISTS "cancel_at_period_end"
    `);
  }
}
