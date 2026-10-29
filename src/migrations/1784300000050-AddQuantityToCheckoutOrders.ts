import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `quantity` a `checkout_orders`: cuántas unidades del `catalog_price` se cobran en la orden.
 *
 * Hasta ahora cada compra de documentos era de UNA unidad del precio, así que la orden no
 * necesitaba decir cuántas. Con la selección de cantidad antes de Checkout, una misma oferta de
 * "1 documento" se compra 5 o 40 veces en un solo pago —**sin crear un precio en Stripe por cada
 * cantidad**— y la orden tiene que guardar qué cantidad se validó para que el webhook pueda
 * compararla con lo que Stripe dice que se pagó antes de acreditar.
 *
 * `amount` NO cambia de significado para las órdenes existentes, pero sí se precisa: es el importe
 * TOTAL esperado (precio unitario × `quantity`). Para todas las filas anteriores `quantity` es 1,
 * así que su `amount` ya era el total.
 *
 * **`DEFAULT 1` y no un backfill aparte**: todas las órdenes previas —de suscripción y de
 * documentos— se cobraron con una unidad, que es exactamente lo que el default escribe. Las de
 * suscripción seguirán naciendo con 1 porque el alta de un plan nunca lleva cantidad.
 *
 * `CHECK (quantity > 0)`: una orden de cero unidades no cobra nada y no tiene nada que acreditar.
 * El máximo por compra (`MAX_DOCUMENT_CREDITS_PER_PURCHASE`) NO se impone aquí: es una regla
 * comercial que puede moverse sin migrar, y la base sólo protege lo que nunca puede ser verdad.
 *
 * Repetible por el mismo motivo que el resto de la serie: la columna con `IF NOT EXISTS` y la
 * restricción con la comprobación previa sobre `pg_constraint`, para converger desde una base que
 * ya la tenga creada por `synchronize`.
 */
export class AddQuantityToCheckoutOrders1784300000050 implements MigrationInterface {
  name = 'AddQuantityToCheckoutOrders1784300000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkout_orders"
      ADD COLUMN IF NOT EXISTS "quantity" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_checkout_orders_quantity'
        ) THEN
          ALTER TABLE "checkout_orders"
            ADD CONSTRAINT "CHK_checkout_orders_quantity" CHECK ("quantity" > 0);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // La restricción se va primero: depende de la columna.
    await queryRunner.query(`
      ALTER TABLE "checkout_orders"
      DROP CONSTRAINT IF EXISTS "CHK_checkout_orders_quantity"
    `);
    await queryRunner.query(`
      ALTER TABLE "checkout_orders" DROP COLUMN IF EXISTS "quantity"
    `);
  }
}
