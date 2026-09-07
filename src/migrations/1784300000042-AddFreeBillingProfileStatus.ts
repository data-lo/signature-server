import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `FREE` a `billing_profiles_status_enum`, y NADA más.
 *
 * Va sola y fuera de transacción por una restricción de Postgres, no por gusto: un valor nuevo
 * de un enum no se puede USAR en la misma transacción en la que se declara. Con el `ALTER TYPE`
 * y el `INSERT ... 'FREE'` juntos, el motor aborta con
 *
 * ```
 * 55P04: unsafe use of new value "FREE" of enum type billing_profiles_status_enum
 * HINT: New enum values must be committed before they can be used.
 * ```
 *
 * De ahí las dos migraciones: ésta declara el valor y confirma, y la siguiente
 * (`IntroduceFreeBillingProfiles`) ya puede escribirlo. `transaction = false` es lo que hace que
 * confirme por su cuenta aunque el runner esté agrupando las migraciones pendientes en una sola
 * transacción, que es su modo por defecto.
 *
 * Renunciar a la transacción aquí no arriesga nada: es una única sentencia DDL aditiva e
 * idempotente. Lo que sí necesita atomicidad —el alta retroactiva de perfiles— vive en la
 * siguiente, que sí es transaccional.
 */
export class AddFreeBillingProfileStatus1784300000042 implements MigrationInterface {
  name = 'AddFreeBillingProfileStatus1784300000042';

  /** Ver el docblock: no es un descuido, es la condición para que la siguiente funcione. */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `IF NOT EXISTS` deja la migración repetible: en una base de desarrollo que ya levantó el
     * esquema con `synchronize: true`, el valor puede estar puesto desde antes.
     */
    await queryRunner.query(
      `ALTER TYPE "public"."billing_profiles_status_enum" ADD VALUE IF NOT EXISTS 'FREE'`,
    );
  }

  /**
   * No se quita el valor: Postgres no sabe eliminar valores de un enum sin recrear el tipo y
   * todas las columnas que lo usan, y dejarlo de más no molesta a nadie. Quien revierta esto
   * quiere deshacer los perfiles Free, y de eso se encarga el `down` de la migración siguiente.
   */
  public async down(): Promise<void> {
    // Intencionadamente vacío.
  }
}
