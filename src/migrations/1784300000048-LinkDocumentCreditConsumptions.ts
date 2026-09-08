import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deja `document_credit_consumptions` en condiciones de ser el recibo de un documento, agrega el
 * origen `FREE_GRANT` a los lotes y `billing_source` al perfil.
 *
 * La tabla existía desde `CreateBillingSchema1784300000034` pero nunca se escribió: no había
 * ningún flujo que consumiera créditos, así que quedó como el esqueleto de una idea. Lo que le
 * falta para servir es lo que agrega esta migración:
 *
 * - **`billing_profile_id`**: a quién se le cobró. Se podía deducir por el lote, pero la consulta
 *   natural de facturación —"cuánto consumió esta cuenta"— tenía que pasar por `credit_lots` para
 *   responderla.
 * - **`units` → `credits_consumed`**: el nombre nuevo dice qué se descuenta. `units` no decía de
 *   qué.
 * - **`CHECK (credits_consumed > 0)` en vez de `= 1`**: crear un documento cuesta uno, pero ya se
 *   contemplan consumos de varios (firma por lotes, biometría) y con `= 1` cada uno de ésos
 *   exigiría migrar la restricción antes de poder escribirse.
 * - **`created_at`**: cuándo se registró, separado de `consumed_at`, que es cuándo se gastó.
 * - **`signature_type` pasa a nullable**: el consumo se resuelve con el documento, la cuenta y el
 *   usuario; exigir el tipo de firma obligaría a cargar el documento sólo para llenar una columna
 *   que hoy nadie consulta.
 *
 * **Se puede imponer `NOT NULL` sin backfill porque la tabla está vacía.** No es una suposición:
 * ningún código la escribía. Si en algún entorno tuviera filas, el `ADD COLUMN` sin default
 * fallaría en voz alta —que es lo correcto— en vez de inventarles un perfil.
 *
 * **Los documentos históricos no se tocan.** Esta migración no crea consumos para los documentos
 * que ya existen ni descuenta nada por ellos: quedan sin fila, que es exactamente lo que son —
 * documentos creados antes de que hubiera créditos que gastar.
 *
 * **`billing_profiles.billing_source` estrena su propio tipo**, `billing_profile_source_enum`, en
 * vez de reutilizar `billing_source_enum` —el de `subscription_billing_history.source`—. Aquél no
 * admite `FREE` y no puede admitirlo: `CHK_subscription_billing_history_origin_evidence` le exige
 * a cada origen una evidencia de cobro, y un plan gratuito no tiene ninguna. Agregarle el valor
 * obligaría a relajar esa restricción para todos los renglones del historial. Ver el docblock de
 * `BILLING_PROFILE_SOURCE_ENUM`.
 *
 * **Aviso para quien fusione**: el ticket del cron de expiración manual también añade esta
 * columna, con el enum compartido de tres valores. Al integrar hay que quedarse con UNA
 * definición; la de aquí no toca el historial, que es lo que la hace más segura de las dos.
 */
export class LinkDocumentCreditConsumptions1784300000048 implements MigrationInterface {
  name = 'LinkDocumentCreditConsumptions1784300000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `FREE_GRANT`: el lote de bienvenida del plan gratuito. Se agrega al enum ANTES de la tabla
     * porque el alta de cuentas empieza a emitirlo en cuanto se despliegue el código.
     *
     * `IF NOT EXISTS` (Postgres 12+) hace repetible el `ALTER TYPE`, que de otro modo falla si el
     * valor ya está — el caso de una base de desarrollo levantada con `synchronize`.
     */
    await queryRunner.query(`
      ALTER TYPE "public"."credit_lots_origin_enum"
      ADD VALUE IF NOT EXISTS 'FREE_GRANT'
    `);

    /**
     * `billing_source` del perfil: por dónde se le factura HOY. Nace en `FREE` para todas las
     * filas existentes —el default cubre el backfill sin escribir ninguna— porque hasta ahora
     * nadie distinguía, y un perfil de pago se corrige solo en su próximo cobro
     * (`RegisterSubscriptionBillingUseCase.updateProfile`).
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'billing_profile_source_enum'
        ) THEN
          CREATE TYPE "public"."billing_profile_source_enum"
            AS ENUM ('STRIPE', 'MANUAL', 'FREE');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "billing_profiles"
      ADD COLUMN IF NOT EXISTS "billing_source"
        "public"."billing_profile_source_enum" NOT NULL DEFAULT 'FREE'
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        ADD COLUMN IF NOT EXISTS "billing_profile_id" uuid NOT NULL,
        ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    `);

    /**
     * Se tira antes de crearla porque `ADD CONSTRAINT` no admite `IF NOT EXISTS`: en desarrollo
     * el esquema sale además de las entidades (`synchronize: true`, ver `app.module.ts`), así que
     * la relación de `DocumentCreditConsumptionEntity` ya trae su clave foránea puesta cuando la
     * migración corre, y un `ADD` a secas dejaba el arranque en bucle con "constraint already
     * exists". Tirar y volver a poner la deja idéntica en los dos caminos.
     */
    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP CONSTRAINT IF EXISTS "FK_document_credit_consumptions_billing_profile"
    `);
    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
      ADD CONSTRAINT "FK_document_credit_consumptions_billing_profile"
      FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id")
      ON DELETE RESTRICT
    `);

    /**
     * El renombre va condicionado a que la columna vieja siga estando, para que la migración
     * corra también en una base cuyo esquema ya salió de las entidades actualizadas.
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'document_credit_consumptions'
            AND column_name = 'units'
        ) THEN
          ALTER TABLE "document_credit_consumptions"
            RENAME COLUMN "units" TO "credits_consumed";
        END IF;
      END $$;
    `);

    // El CHECK viejo (`units = 1`) se llamaba por su columna: se cambia entero, no se edita.
    // El nuevo se tira antes de ponerlo por el mismo motivo que la foránea de arriba.
    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP CONSTRAINT IF EXISTS "CHK_document_credit_consumptions_units"
    `);
    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP CONSTRAINT IF EXISTS "CHK_document_credit_consumptions_credits"
    `);
    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        ADD CONSTRAINT "CHK_document_credit_consumptions_credits"
        CHECK ("credits_consumed" > 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        ALTER COLUMN "signature_type" DROP NOT NULL
    `);

    /**
     * El índice que sostiene la búsqueda del lote a consumir: por perfil, con saldo y sin
     * caducar, ordenados por la política de gasto. Sin él, cada creación de documento haría un
     * recorrido secuencial de `credit_lots` dentro de la transacción que bloquea la fila.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_credit_lots_spendable"
      ON "credit_lots" ("billing_profile_id", "priority" DESC, "expires_at", "created_at")
      WHERE "remaining" > 0
    `);
  }

  /**
   * `FREE_GRANT` no se quita del enum: Postgres no sabe borrar un valor de un tipo enumerado sin
   * recrearlo entero, y recrearlo obligaría a reescribir `credit_lots` y a que ninguna fila lo
   * estuviera usando. Dejarlo es inofensivo — un valor que nadie escribe no molesta a nadie.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_credit_lots_spendable"
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        ALTER COLUMN "signature_type" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP CONSTRAINT IF EXISTS "CHK_document_credit_consumptions_credits"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'document_credit_consumptions'
            AND column_name = 'credits_consumed'
        ) THEN
          ALTER TABLE "document_credit_consumptions"
            RENAME COLUMN "credits_consumed" TO "units";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        ADD CONSTRAINT "CHK_document_credit_consumptions_units" CHECK ("units" = 1)
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP CONSTRAINT IF EXISTS "FK_document_credit_consumptions_billing_profile"
    `);

    await queryRunner.query(`
      ALTER TABLE "document_credit_consumptions"
        DROP COLUMN IF EXISTS "billing_profile_id",
        DROP COLUMN IF EXISTS "created_at"
    `);

    await queryRunner.query(`
      ALTER TABLE "billing_profiles" DROP COLUMN IF EXISTS "billing_source"
    `);
    // El tipo se borra DESPUÉS de su única columna, o Postgres lo rechaza por estar en uso.
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."billing_profile_source_enum"
    `);
  }
}
