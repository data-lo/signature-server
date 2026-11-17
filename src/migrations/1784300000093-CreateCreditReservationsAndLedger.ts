import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Créditos biométricos, reservas y ledger de movimientos.
 *
 * - `credit_type_enum` y `credit_lots.credit_type`: cada lote es de un tipo. Los existentes quedan
 *   como `DOCUMENT_SIGNATURE`, que es lo único que existía.
 * - `credit_lots.reserved`: créditos bloqueados por reservas activas. Disponible =
 *   `remaining - reserved`, con un `CHECK` que impide reservar más de lo que queda.
 * - `document_credit_packs.credit_type`: de qué tipo son los créditos que acredita un paquete.
 * - `credit_reservations`: reservas documentales (por documento) y biométricas (por intento).
 * - `credit_ledger_entries`: un movimiento inmutable por cada cambio de `remaining` o `reserved`.
 *   Un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE`.
 *
 * Backfill del ledger, para que el saldo actual pueda reconstruirse desde él:
 * - Cada lote existente: `PURCHASE` si lo originó un cobro de Stripe (factura o pago), `GRANT` si
 *   no (bienvenida, recarga de plataforma), por `issued`.
 * - Cada consumo de `document_credit_consumptions`: `CONSUME` por `credits_consumed`.
 *
 * Las claves de idempotencia del backfill (`issue:lot:<id>` y `consume:document:<id>`) son las
 * mismas que escribe el código, así que un consumo posterior del mismo documento choca contra
 * el índice en vez de duplicarse.
 */
export class CreateCreditReservationsAndLedger1784300000093 implements MigrationInterface {
  name = 'CreateCreditReservationsAndLedger1784300000093';

  /**
   * Crea tipos, columnas, tablas, el trigger de inmutabilidad y el backfill del ledger.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no existen `credit_lots`, `document_credit_packs`,
   *   `billing_profiles`, `documents` o `biometric_signature_attempts`.
   *
   * @example
   * ```ts
   * await new CreateCreditReservationsAndLedger1784300000093().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "credit_type_enum" AS ENUM ('DOCUMENT_SIGNATURE', 'BIOMETRIC_SIGNATURE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "credit_ledger_movement_type_enum" AS ENUM ('PURCHASE', 'GRANT', 'RESERVE', 'CONSUME', 'RELEASE', 'REFUND', 'ADJUSTMENT')`,
    );
    await queryRunner.query(
      `CREATE TYPE "credit_reservation_status_enum" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')`,
    );

    await queryRunner.query(`
      ALTER TABLE "credit_lots"
        ADD COLUMN "credit_type" "credit_type_enum" NOT NULL DEFAULT 'DOCUMENT_SIGNATURE',
        ADD COLUMN "reserved" integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT "CHK_credit_lots_reserved" CHECK ("reserved" >= 0 AND "reserved" <= "remaining"),
        ADD CONSTRAINT "UQ_credit_lots_id_profile_type" UNIQUE ("id", "billing_profile_id", "credit_type")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_credit_lots_consumption"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_lots_consumption" ON "credit_lots" ("billing_profile_id", "credit_type", "origin", "remaining", "period_end")`,
    );

    await queryRunner.query(
      `ALTER TABLE "document_credit_packs" ADD COLUMN "credit_type" "credit_type_enum" NOT NULL DEFAULT 'DOCUMENT_SIGNATURE'`,
    );

    await queryRunner.query(`
      CREATE TABLE "credit_reservations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "credit_lot_id" uuid NOT NULL,
        "credit_type" "credit_type_enum" NOT NULL,
        "document_id" uuid,
        "biometric_signature_attempt_id" uuid,
        "quantity" integer NOT NULL,
        "status" "credit_reservation_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "released_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_reservations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_credit_reservations_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_credit_reservations_subject" CHECK (
          ("credit_type" = 'DOCUMENT_SIGNATURE' AND "document_id" IS NOT NULL)
          OR ("credit_type" = 'BIOMETRIC_SIGNATURE' AND "biometric_signature_attempt_id" IS NOT NULL)
        ),
        CONSTRAINT "FK_credit_reservations_billing_profile_id"
          FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_credit_reservations_credit_lot"
          FOREIGN KEY ("credit_lot_id", "billing_profile_id", "credit_type")
          REFERENCES "credit_lots"("id", "billing_profile_id", "credit_type") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_credit_reservations_document_id"
          FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_credit_reservations_biometric_signature_attempt_id"
          FOREIGN KEY ("biometric_signature_attempt_id") REFERENCES "biometric_signature_attempts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_credit_reservations_active_document" ON "credit_reservations" ("document_id") WHERE "status" = 'ACTIVE' AND "credit_type" = 'DOCUMENT_SIGNATURE'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_credit_reservations_active_biometric_attempt" ON "credit_reservations" ("biometric_signature_attempt_id") WHERE "status" = 'ACTIVE' AND "credit_type" = 'BIOMETRIC_SIGNATURE'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_reservations_active_expiry" ON "credit_reservations" ("expires_at") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_reservations_document" ON "credit_reservations" ("document_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "credit_ledger_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billing_profile_id" uuid NOT NULL,
        "credit_lot_id" uuid,
        "credit_type" "credit_type_enum" NOT NULL,
        "movement_type" "credit_ledger_movement_type_enum" NOT NULL,
        "quantity" integer NOT NULL,
        "credit_reservation_id" uuid,
        "document_id" uuid,
        "biometric_signature_attempt_id" uuid,
        "stripe_payment_intent_id" character varying,
        "idempotency_key" character varying(255) NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_credit_ledger_entries_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "FK_credit_ledger_entries_billing_profile_id"
          FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_credit_ledger_entries_credit_lot"
          FOREIGN KEY ("credit_lot_id", "billing_profile_id", "credit_type")
          REFERENCES "credit_lots"("id", "billing_profile_id", "credit_type") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_credit_ledger_entries_credit_reservation_id"
          FOREIGN KEY ("credit_reservation_id") REFERENCES "credit_reservations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_credit_ledger_entries_idempotency_key" ON "credit_ledger_entries" ("idempotency_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_ledger_entries_profile_created" ON "credit_ledger_entries" ("billing_profile_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_ledger_entries_lot" ON "credit_ledger_entries" ("credit_lot_id")`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "credit_ledger_entries_reject_change"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'credit_ledger_entries es inmutable: % no está permitido', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_credit_ledger_entries_immutable"
        BEFORE UPDATE OR DELETE ON "credit_ledger_entries"
        FOR EACH ROW EXECUTE FUNCTION "credit_ledger_entries_reject_change"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_credit_ledger_entries_no_truncate"
        BEFORE TRUNCATE ON "credit_ledger_entries"
        FOR EACH STATEMENT EXECUTE FUNCTION "credit_ledger_entries_reject_change"()
    `);

    await queryRunner.query(`
      INSERT INTO "credit_ledger_entries"
        ("billing_profile_id", "credit_lot_id", "credit_type", "movement_type", "quantity",
         "stripe_payment_intent_id", "idempotency_key", "metadata", "created_at")
      SELECT
        l."billing_profile_id", l."id", l."credit_type",
        CASE
          WHEN l."stripe_payment_intent_id" IS NOT NULL OR l."stripe_invoice_id" IS NOT NULL
            THEN 'PURCHASE'::"credit_ledger_movement_type_enum"
          ELSE 'GRANT'::"credit_ledger_movement_type_enum"
        END,
        l."issued", l."stripe_payment_intent_id", 'issue:lot:' || l."id",
        jsonb_build_object('origin', l."origin", 'stripeInvoiceId', l."stripe_invoice_id", 'backfill', true),
        l."created_at"
      FROM "credit_lots" l
    `);
    await queryRunner.query(`
      INSERT INTO "credit_ledger_entries"
        ("billing_profile_id", "credit_lot_id", "credit_type", "movement_type", "quantity",
         "document_id", "idempotency_key", "metadata", "created_at")
      SELECT
        l."billing_profile_id", l."id", l."credit_type", 'CONSUME', c."credits_consumed",
        c."document_id", 'consume:document:' || c."document_id",
        jsonb_build_object('signatureType', c."signature_type", 'backfill', true),
        c."consumed_at"
      FROM "document_credit_consumptions" c
      JOIN "credit_lots" l ON l."id" = c."credit_lot_id"
      WHERE c."reversed_at" IS NULL
    `);
  }

  /**
   * Revierte todo: tablas, trigger, columnas y tipos. Se pierde el ledger y las reservas; las
   * reservas activas deben resolverse antes, porque sus créditos bloqueados vuelven al saldo al
   * desaparecer `reserved`.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si algún paquete o lote ya es `BIOMETRIC_SIGNATURE`: borrar la
   *   columna los convertiría en documentales sin avisar.
   *
   * @example
   * ```ts
   * await new CreateCreditReservationsAndLedger1784300000093().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const [biometric] = await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM "credit_lots" WHERE "credit_type" <> 'DOCUMENT_SIGNATURE')
        + (SELECT count(*) FROM "document_credit_packs" WHERE "credit_type" <> 'DOCUMENT_SIGNATURE') AS "count"
    `);
    if (Number(biometric?.count ?? 0) > 0) {
      throw new Error(
        'Hay lotes o paquetes de créditos biométricos: revertir los convertiría en documentales.',
      );
    }

    await queryRunner.query(`DROP TABLE "credit_ledger_entries"`);
    await queryRunner.query(
      `DROP FUNCTION "credit_ledger_entries_reject_change"()`,
    );
    await queryRunner.query(`DROP TABLE "credit_reservations"`);
    await queryRunner.query(
      `ALTER TABLE "document_credit_packs" DROP COLUMN "credit_type"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_credit_lots_consumption"`,
    );
    await queryRunner.query(`
      ALTER TABLE "credit_lots"
        DROP CONSTRAINT "UQ_credit_lots_id_profile_type",
        DROP CONSTRAINT "CHK_credit_lots_reserved",
        DROP COLUMN "reserved",
        DROP COLUMN "credit_type"
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_lots_consumption" ON "credit_lots" ("billing_profile_id", "origin", "remaining", "period_end")`,
    );
    await queryRunner.query(`DROP TYPE "credit_reservation_status_enum"`);
    await queryRunner.query(`DROP TYPE "credit_ledger_movement_type_enum"`);
    await queryRunner.query(`DROP TYPE "credit_type_enum"`);
  }
}
