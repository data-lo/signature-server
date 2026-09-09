import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Stripe = require('stripe');

import { AppModule } from '../app.module';
import { CatalogSyncService } from '../billing/catalog/catalog-sync.service';
import { StripePaymentService } from '../payments/stripe/stripe-payment.service';

/**
 * Importa el catálogo de Stripe (productos y precios) al espejo local.
 *
 * **Por qué hace falta.** `catalog_items` / `catalog_prices` se alimentan ÚNICAMENTE de los
 * webhooks `product.*` y `price.*`, que Stripe emite cuando alguien crea o edita un producto —
 * nunca a petición. Un entorno que no estaba escuchando en ese momento (uno local recién
 * levantado, un despliegue nuevo, una base restaurada) se queda con el espejo vacío para
 * siempre, y ahí el producto se rompe de una forma desconcertante: la pantalla de planes SÍ
 * muestra opciones —`GET /payments/services` las lee de Stripe en vivo— pero al elegir una, el
 * checkout responde "El plan seleccionado no está disponible", porque
 * `findSellableRecurringPrice` sólo acepta precios que estén en el espejo. Sin checkout no hay
 * suscripción, y el `billing_profile` se queda en `free` sin que nadie sepa por qué.
 *
 * **Pasa por `CatalogSyncService`, el mismo camino que el webhook.** No escribe una sola fila por
 * su cuenta: así el espejo se construye con las mismas reglas —`metadata.catalogType` decide qué
 * es un plan y qué un paquete de créditos, el resto se ignora— y este script no puede introducir
 * al catálogo nada que un webhook no fuera a aceptar. Es lo que evita que el espejo, que existe
 * como lista blanca de lo vendible, se convierta en un volcado de todo lo que haya en Stripe.
 *
 * Es idempotente: `syncProductUpserted` / `syncPriceUpserted` hacen upsert por el id de Stripe,
 * así que correrlo dos veces deja el mismo resultado.
 *
 *   npm run catalog:sync        # local, sobre src/
 *   npm run catalog:sync:prod   # sobre dist/
 */

export interface SyncStripeCatalogSummary {
  products: number;
  prices: number;
  /** Productos sin `metadata.catalogType` reconocido: el catálogo local los ignora a propósito. */
  ignored: number;
  failed: number;
}

/** Lo mínimo que el script necesita de Stripe; tipado así para poder probarlo sin red. */
export interface StripeCatalogReader {
  products: {
    list(params: Stripe.ProductListParams): AsyncIterable<Stripe.Product>;
  };
  prices: {
    list(params: Stripe.PriceListParams): AsyncIterable<Stripe.Price>;
  };
}

/** Lo mínimo que el script necesita del sincronizador. */
export interface CatalogUpserter {
  syncProductUpserted(product: Stripe.Product): Promise<void>;
  syncPriceUpserted(
    price: Stripe.Price,
    product: Stripe.Product,
  ): Promise<void>;
}

/**
 * Recorre el catálogo de Stripe y lo vuelca al espejo local.
 *
 * @param stripe - Cliente de Stripe (o un doble en las pruebas).
 * @param catalogSync - `CatalogSyncService`, que es quien decide qué entra al catálogo.
 * @param logger - Dónde escribir el avance.
 * @returns Cuántos productos y precios se sincronizaron, cuántos se ignoraron y cuántos fallaron.
 *
 * Un producto que falla NO aborta la corrida: se registra y se sigue con el siguiente. Importar
 * el catálogo es una operación de arranque, y dejar el espejo a medias por un producto con
 * metadata mal puesta obligaría a arreglarlo antes de poder vender los demás. El código de
 * salida distinto de cero es lo que avisa de que algo quedó fuera.
 *
 * Los precios se piden POR PRODUCTO y no de una sola lista global: `syncPriceUpserted` necesita
 * el producto al que pertenece cada precio, y pedirlo suelto obligaría a resolverlo con una
 * llamada extra por precio.
 */
export async function syncStripeCatalog(
  stripe: StripeCatalogReader,
  catalogSync: CatalogUpserter,
  logger: Pick<Logger, 'log' | 'warn' | 'error'>,
): Promise<SyncStripeCatalogSummary> {
  const summary: SyncStripeCatalogSummary = {
    products: 0,
    prices: 0,
    ignored: 0,
    failed: 0,
  };

  for await (const product of stripe.products.list({
    active: true,
    limit: 100,
  })) {
    const catalogType = product.metadata?.catalogType?.trim();
    if (!catalogType) {
      summary.ignored += 1;
      logger.warn(
        `Producto ${product.id} (${product.name}) sin metadata.catalogType: el catálogo local lo ignora, igual que haría el webhook.`,
      );
      continue;
    }

    try {
      await catalogSync.syncProductUpserted(product);
      summary.products += 1;

      /**
       * También los precios inactivos: `syncPriceUpserted` los registra como no vendibles, y es
       * lo que permite seguir facturando una renovación de un precio ya retirado (ver
       * `findPriceForInvoice`). Omitirlos dejaría esas suscripciones sin su precio de origen.
       */
      for await (const price of stripe.prices.list({
        product: product.id,
        limit: 100,
      })) {
        await catalogSync.syncPriceUpserted(price, product);
        summary.prices += 1;
      }

      logger.log(`Producto ${product.id} (${product.name}) sincronizado.`);
    } catch (error) {
      summary.failed += 1;
      logger.error(
        `No se pudo sincronizar el producto ${product.id} (${product.name}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const logger = new Logger('SyncStripeCatalog');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const summary = await syncStripeCatalog(
      app.get(StripePaymentService).client as unknown as StripeCatalogReader,
      app.get(CatalogSyncService),
      logger,
    );

    logger.log(
      `Catálogo sincronizado: ${summary.products} productos, ${summary.prices} precios, ` +
        `${summary.ignored} ignorados, ${summary.failed} con error.`,
    );

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

// `require.main` distingue ejecutar el script de importarlo desde una prueba: sin esta guarda,
// importar `syncStripeCatalog` levantaría la aplicación entera y se conectaría a Stripe.
if (require.main === module) {
  main().catch((error) => {
    console.error('Error sincronizando el catálogo de Stripe:', error);
    process.exit(1);
  });
}
