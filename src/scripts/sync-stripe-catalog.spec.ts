import Stripe = require('stripe');
import {
  syncStripeCatalog,
  type CatalogUpserter,
  type StripeCatalogReader,
} from './sync-stripe-catalog';

function product(
  id: string,
  catalogType?: string,
  name = `Producto ${id}`,
): Stripe.Product {
  return {
    id,
    name,
    metadata: catalogType ? { catalogType } : {},
  } as unknown as Stripe.Product;
}

function price(id: string, productId: string, active = true): Stripe.Price {
  return { id, product: productId, active } as unknown as Stripe.Price;
}

/** Doble de Stripe que devuelve productos y, por producto, sus precios. */
function stripeWith(
  products: Stripe.Product[],
  pricesByProduct: Record<string, Stripe.Price[]> = {},
): StripeCatalogReader {
  return {
    products: {
      list: () => toAsyncIterable(products),
    },
    prices: {
      list: (params: Stripe.PriceListParams) =>
        toAsyncIterable(pricesByProduct[params.product as string] ?? []),
    },
  };
}

function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function upserterSpy(): CatalogUpserter & {
  syncProductUpserted: jest.Mock;
  syncPriceUpserted: jest.Mock;
} {
  return {
    syncProductUpserted: jest.fn().mockResolvedValue(undefined),
    syncPriceUpserted: jest.fn().mockResolvedValue(undefined),
  };
}

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

/**
 * Bug "en local no se guarda la información del plan": `catalog_items`/`catalog_prices` sólo se
 * llenan con los webhooks `product.*`/`price.*`, que Stripe emite al editar un producto y nunca a
 * petición. Un entorno que no los recibió muestra planes que luego no puede vender — el checkout
 * responde "El plan seleccionado no está disponible". Este script importa el catálogo a mano.
 */
describe('syncStripeCatalog', () => {
  beforeEach(() => {
    silentLogger.log.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('vuelca cada producto y sus precios al espejo local', async () => {
    const plus = product('prod_plus', 'plan');
    const catalogSync = upserterSpy();

    const summary = await syncStripeCatalog(
      stripeWith([plus], {
        prod_plus: [
          price('price_mensual', 'prod_plus'),
          price('price_anual', 'prod_plus'),
        ],
      }),
      catalogSync,
      silentLogger,
    );

    expect(catalogSync.syncProductUpserted).toHaveBeenCalledWith(plus);
    expect(catalogSync.syncPriceUpserted).toHaveBeenCalledTimes(2);
    // El precio viaja con SU producto: `syncPriceUpserted` lo necesita para saber si es un plan
    // o un paquete de créditos, y pedirlo suelto costaría una llamada extra por precio.
    expect(catalogSync.syncPriceUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'price_mensual' }),
      plus,
    );
    expect(summary).toEqual({ products: 1, prices: 2, ignored: 0, failed: 0 });
  });

  /**
   * El espejo es una lista blanca de lo vendible, no un volcado de Stripe: sin
   * `metadata.catalogType` el webhook tampoco lo daría de alta, y el script no puede ser una
   * puerta trasera para meter al catálogo algo que aquél rechazaría.
   */
  it('ignora los productos sin metadata.catalogType, sin tocarlos', async () => {
    const catalogSync = upserterSpy();

    const summary = await syncStripeCatalog(
      stripeWith([product('prod_suelto')], {
        prod_suelto: [price('price_suelto', 'prod_suelto')],
      }),
      catalogSync,
      silentLogger,
    );

    expect(catalogSync.syncProductUpserted).not.toHaveBeenCalled();
    expect(catalogSync.syncPriceUpserted).not.toHaveBeenCalled();
    expect(summary).toEqual({ products: 0, prices: 0, ignored: 1, failed: 0 });
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('prod_suelto'),
    );
  });

  /**
   * Importar el catálogo es una operación de arranque: dejar el espejo a medias por un producto
   * con la metadata mal puesta obligaría a arreglarlo antes de poder vender los demás.
   */
  it('sigue con los demás productos cuando uno falla, y lo cuenta', async () => {
    const catalogSync = upserterSpy();
    catalogSync.syncProductUpserted.mockImplementation((p: Stripe.Product) =>
      p.id === 'prod_roto'
        ? Promise.reject(new Error('metadata inválida'))
        : Promise.resolve(),
    );

    const summary = await syncStripeCatalog(
      stripeWith(
        [product('prod_roto', 'plan'), product('prod_bueno', 'plan')],
        { prod_bueno: [price('price_bueno', 'prod_bueno')] },
      ),
      catalogSync,
      silentLogger,
    );

    expect(summary).toEqual({ products: 1, prices: 1, ignored: 0, failed: 1 });
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('prod_roto'),
    );
  });

  /**
   * Los precios retirados también entran: `syncPriceUpserted` los registra como no vendibles, y
   * son los que permiten seguir facturando la renovación de una suscripción contratada con un
   * precio que ya no se ofrece (ver `findPriceForInvoice`).
   */
  it('incluye los precios inactivos', async () => {
    const plan = product('prod_plan', 'plan');
    const catalogSync = upserterSpy();

    const summary = await syncStripeCatalog(
      stripeWith([plan], {
        prod_plan: [
          price('price_vigente', 'prod_plan'),
          price('price_retirado', 'prod_plan', false),
        ],
      }),
      catalogSync,
      silentLogger,
    );

    expect(catalogSync.syncPriceUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'price_retirado', active: false }),
      plan,
    );
    expect(summary.prices).toBe(2);
  });

  it('no falla con un catálogo vacío', async () => {
    const summary = await syncStripeCatalog(
      stripeWith([]),
      upserterSpy(),
      silentLogger,
    );

    expect(summary).toEqual({ products: 0, prices: 0, ignored: 0, failed: 0 });
  });
});
