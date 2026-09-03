import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import Stripe = require('stripe');
import { CatalogSyncService } from './catalog-sync.service';
import { PlanEntity } from './plan.entity';
import { PlanPriceEntity } from './plan-price.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import {
  MissingDocumentPackMetadataException,
  MissingPlanTypeMetadataException,
  UnknownEligiblePlanMetadataException,
} from './exceptions/catalog-sync.exceptions';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    delete: jest.fn(),
    save: jest.fn(async (data) => data),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function buildStripeProduct(
  overrides: Partial<Stripe.Product> = {},
): Stripe.Product {
  return {
    id: 'prod_1',
    name: 'Plan Pro',
    active: true,
    metadata: {},
    ...overrides,
  } as Stripe.Product;
}

/** Un precio recurrente de Stripe, como llega en `price.created`/`price.updated`. */
function buildStripePrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_pro_mensual',
    active: true,
    currency: 'mxn',
    unit_amount: 49900,
    product: 'prod_pro',
    metadata: {},
    recurring: { interval: 'month', interval_count: 1 },
    ...overrides,
  } as Stripe.Price;
}

/** Producto de plan, ya con la metadata que lo enruta al catalogo de planes. */
function buildPlanProduct(overrides: Partial<Stripe.Product> = {}) {
  return buildStripeProduct({
    id: 'prod_pro',
    name: 'Plan Pro',
    active: true,
    metadata: { catalogType: 'plan', planType: 'pro' },
    ...overrides,
  });
}

/** Producto de paquete de documentos, con la metadata comercial que no viaja en el precio. */
function buildPackProduct(overrides: Partial<Stripe.Product> = {}) {
  return buildStripeProduct({
    id: 'prod_pack',
    name: 'Paquete de 50 documentos',
    active: true,
    metadata: { catalogType: 'document_pack', documentsGranted: '50' },
    ...overrides,
  });
}

describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let planRepository: ReturnType<typeof createMockRepository>;
  let planPriceRepository: ReturnType<typeof createMockRepository>;
  let documentPackOfferRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    planRepository = createMockRepository();
    planPriceRepository = createMockRepository();
    documentPackOfferRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncService,
        { provide: getRepositoryToken(PlanEntity), useValue: planRepository },
        {
          provide: getRepositoryToken(PlanPriceEntity),
          useValue: planPriceRepository,
        },
        {
          provide: getRepositoryToken(DocumentPackOfferEntity),
          useValue: documentPackOfferRepository,
        },
      ],
    }).compile();

    service = module.get(CatalogSyncService);
  });

  describe('un producto sin metadata.catalogType reconocida no pertenece al catálogo', () => {
    it('lo ignora sin tocar ningún repositorio (sin metadata en absoluto)', async () => {
      await service.syncProductUpserted(buildStripeProduct({ metadata: {} }));

      expect(planRepository.findOne).not.toHaveBeenCalled();
      expect(documentPackOfferRepository.findOne).not.toHaveBeenCalled();
    });

    it('lo ignora con un catalogType no reconocido', async () => {
      await service.syncProductUpserted(
        buildStripeProduct({ metadata: { catalogType: 'algo-raro' } }),
      );

      expect(planRepository.findOne).not.toHaveBeenCalled();
      expect(documentPackOfferRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('product.created / product.updated — plan', () => {
    it('crea el plan con límites conservadores cuando no hay fila local previa', async () => {
      planRepository.findOne.mockResolvedValue(null);

      await service.syncProductUpserted(
        buildStripeProduct({
          id: 'prod_pro',
          name: 'Plan Pro',
          active: true,
          metadata: { catalogType: 'plan', planType: 'pro' },
        }),
      );

      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          planType: 'pro',
          name: 'Plan Pro',
          isActive: true,
          creationSource: 'STRIPE',
          stripeProductId: 'prod_pro',
          documentsIncluded: 1,
        }),
      );
    });

    it('sincroniza nombre/activo/stripeProductId SIN tocar los límites comerciales de una fila existente', async () => {
      const existingPlan = {
        planType: 'pro',
        name: 'Plan Pro (viejo)',
        active: true,
        stripeProductId: null,
        documentsIncluded: 500,
      };
      // Primera búsqueda (por stripeProductId): no encontrada, todavía no está enlazado.
      // Segunda búsqueda (por code, tomado de la metadata): sí encontrada.
      planRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingPlan);

      await service.syncProductUpserted(
        buildStripeProduct({
          id: 'prod_pro',
          name: 'Plan Pro',
          active: true,
          metadata: { catalogType: 'plan', planType: 'pro' },
        }),
      );

      expect(planRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { stripeProductId: 'prod_pro' },
      });
      expect(planRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { planType: 'pro' },
      });
      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          planType: 'pro',
          name: 'Plan Pro',
          isActive: true,
          stripeProductId: 'prod_pro',
          // Estos tres NO vienen del producto de Stripe — deben quedar exactamente como estaban.
          documentsIncluded: 500,
        }),
      );
    });

    it('lanza si el producto se marca como plan sin metadata.planType', async () => {
      await expect(
        service.syncProductUpserted(
          buildStripeProduct({ metadata: { catalogType: 'plan' } }),
        ),
      ).rejects.toThrow(MissingPlanTypeMetadataException);

      expect(planRepository.save).not.toHaveBeenCalled();
    });

    /**
     * `planCode` es como se etiquetaron los productos antes de que la metadata se estandarizara
     * en `planType`: se sigue aceptando para no exigir reeditar el dashboard al desplegar.
     */
    it('acepta el alias planCode de la metadata anterior', async () => {
      planRepository.findOne.mockResolvedValue(null);

      await service.syncProductUpserted(
        buildStripeProduct({
          id: 'prod_pro',
          metadata: { catalogType: 'plan', planCode: 'pro' },
        }),
      );

      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ planType: 'pro' }),
      );
    });

    /**
     * Regresión de idempotencia: procesar el MISMO product.created dos veces (simulando un
     * reintento de Stripe que llegara a este servicio, o dos entregas que ambas pasaran la
     * guarda de `webhook_events`) no debe dejar dos filas — la segunda vez ya se encuentra por
     * `stripeProductId`, que la primera corrida dejó grabado.
     */
    it('procesar el mismo product.created dos veces actualiza la misma fila, no crea una segunda', async () => {
      const product = buildStripeProduct({
        id: 'prod_pro',
        name: 'Plan Pro',
        active: true,
        metadata: { catalogType: 'plan', planType: 'pro' },
      });

      // Primera corrida: no existe por stripeProductId ni por code → se crea.
      planRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await service.syncProductUpserted(product);
      const createdRow = planRepository.save.mock.calls[0][0];

      // Segunda corrida: ahora sí existe por stripeProductId (lo que dejó la primera corrida).
      planRepository.findOne.mockReset();
      planRepository.findOne.mockResolvedValueOnce(createdRow);
      await service.syncProductUpserted(product);

      expect(planRepository.create).toHaveBeenCalledTimes(1);
      expect(planRepository.save).toHaveBeenCalledTimes(2);
      // La segunda vez sólo hizo UNA búsqueda (por stripeProductId, que ya encontró) — nunca
      // cayó al fallback por code, que es el único camino que crearía una fila nueva.
      expect(planRepository.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('product.deleted — plan', () => {
    it('desactiva el plan encontrado por stripeProductId, sin borrarlo', async () => {
      await service.syncProductDeleted(
        buildStripeProduct({
          id: 'prod_pro',
          metadata: { catalogType: 'plan', planType: 'pro' },
        }),
      );

      expect(planRepository.update).toHaveBeenCalledWith(
        { stripeProductId: 'prod_pro' },
        { active: false },
      );
    });

    it('no lanza si no hay ningún plan vinculado a ese producto', async () => {
      planRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.syncProductDeleted(
          buildStripeProduct({
            id: 'prod_huerfano',
            metadata: { catalogType: 'plan', planType: 'pro' },
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('product.created / product.updated — paquete de documentos', () => {
    /**
     * Sólo nombre y estado, y sobre TODAS las ofertas del producto: un mismo paquete tiene una
     * fila por plan elegible y precio, y el nombre del producto es el de todas ellas. Los datos
     * del PRECIO (importe, moneda, documentos, `stripePriceId`) no se tocan desde un evento de
     * producto, que ni siquiera los trae.
     */
    it('sincroniza nombre/activo de todas las ofertas vinculadas, SIN tocar precio/documentos', async () => {
      await service.syncProductUpserted(
        buildPackProduct({
          id: 'prod_pack_50',
          name: 'Paquete de 50 documentos',
          active: true,
        }),
      );

      expect(documentPackOfferRepository.update).toHaveBeenCalledWith(
        { stripeProductId: 'prod_pack_50' },
        { name: 'Paquete de 50 documentos', active: true },
      );
      expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
    });

    it('NO crea un document_pack_offer nuevo sin fila local previa (faltan datos del precio)', async () => {
      documentPackOfferRepository.update.mockResolvedValue({ affected: 0 });

      await service.syncProductUpserted(
        buildPackProduct({ id: 'prod_pack_nuevo' }),
      );

      expect(documentPackOfferRepository.create).not.toHaveBeenCalled();
      expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
    });
  });

  /**
   * Historia "Sincronizar productos y precios de Stripe con el catálogo local". El payload de un
   * evento `price.*` sólo trae el id de su producto: quien recibe el evento lo resuelve y lo pasa
   * ya expandido, porque la metadata que decide a qué tabla va el precio vive en el producto.
   */
  describe('price.created / price.updated — plan', () => {
    it('crea la fila de plan_prices con el importe, la moneda y la periodicidad del precio', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pro_mensual', unit_amount: 49900 }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          planType: 'pro',
          stripePriceId: 'price_pro_mensual',
          amount: 49900,
          currency: 'mxn',
          interval: BILLING_INTERVAL_ENUM.MONTH,
          intervalCount: 1,
          isActive: true,
          effectiveTo: null,
        }),
      );
    });

    it('crea el precio si un reintento de price.updated aún no tiene fila local', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pro_nuevo', unit_amount: 59900 }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          planType: 'pro',
          stripePriceId: 'price_pro_nuevo',
          amount: 59900,
        }),
      );
      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ stripePriceId: 'price_pro_nuevo' }),
      );
    });

    /** El evento del precio puede llegar antes que el de su producto (o después de perderse). */
    it('asegura la fila del plan antes de colgarle el precio', async () => {
      planRepository.findOne.mockResolvedValue(null);
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(buildStripePrice(), buildPlanProduct());

      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ planType: 'pro', stripeProductId: 'prod_pro' }),
      );
      expect(planPriceRepository.save).toHaveBeenCalled();
    });

    /**
     * Criterio "un cambio de importe crea una nueva versión de precio y desactiva la anterior".
     * Stripe no deja editar el `unit_amount` de un `price_...`: publica otro y emite
     * `price.created`, así que un id desconocido siempre es una versión nueva.
     */
    it('un precio nuevo releva al vigente: lo desactiva con su fecha de cierre y agrega una fila', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pro_v2', unit_amount: 59900 }),
        buildPlanProduct(),
      );

      const [criterio, cambios] = planPriceRepository.update.mock.calls[0];
      expect(criterio).toEqual({
        planType: 'pro',
        currency: 'mxn',
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
        isActive: true,
      });
      expect(cambios.isActive).toBe(false);
      expect(cambios.effectiveTo).toBeInstanceOf(Date);

      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePriceId: 'price_pro_v2',
          amount: 59900,
          isActive: true,
        }),
      );
    });

    /**
     * La fila vieja se conserva entera —con su `stripe_price_id`— porque
     * `checkout_orders.plan_price_id` la referencia: sobrescribirla haría que una factura
     * histórica apuntara a un importe que nunca se cobró.
     */
    it('no reescribe ni borra la fila del precio anterior', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pro_v2', unit_amount: 59900 }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.delete).not.toHaveBeenCalled();
      const [, cambios] = planPriceRepository.update.mock.calls[0];
      expect(cambios).not.toHaveProperty('stripePriceId');
      expect(cambios).not.toHaveProperty('amount');
    });

    /** El mensual y el anual del mismo plan conviven: publicar uno no puede dar de baja al otro. */
    it('sólo releva a los precios de la misma periodicidad y moneda', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({
          id: 'price_pro_anual',
          recurring: { interval: 'year', interval_count: 1 },
        } as Partial<Stripe.Price>),
        buildPlanProduct(),
      );

      expect(planPriceRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ interval: BILLING_INTERVAL_ENUM.YEAR }),
        expect.anything(),
      );
    });

    it('un precio archivado no releva a nadie: sólo se guarda inactivo', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pro_v3', active: false }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.update).not.toHaveBeenCalled();
      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePriceId: 'price_pro_v3',
          isActive: false,
        }),
      );
    });

    it('crea una nueva versión si price.updated trae otro importe con el mismo stripePriceId', async () => {
      const existente = {
        id: 'row-1',
        planType: 'pro',
        stripePriceId: 'price_pro_mensual',
        amount: 49900,
        currency: 'mxn',
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
        isActive: true,
        effectiveTo: null,
      };
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(existente);

      await service.syncPriceUpserted(
        buildStripePrice({ unit_amount: 59900 }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'row-1', isActive: false }),
      );
      expect(existente.effectiveTo).toBeInstanceOf(Date);
      expect(planPriceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePriceId: 'price_pro_mensual',
          amount: 59900,
          isActive: true,
        }),
      );
      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePriceId: 'price_pro_mensual',
          amount: 59900,
          isActive: true,
        }),
      );
    });

    it('archivar un precio existente cierra su versión activa sin crear otra', async () => {
      const existente = {
        id: 'row-1',
        planType: 'pro',
        stripePriceId: 'price_pro_mensual',
        amount: 49900,
        isActive: true,
        effectiveTo: null,
      };
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValue(existente);

      await service.syncPriceUpserted(
        buildStripePrice({ active: false, unit_amount: 49900 }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'row-1',
          stripePriceId: 'price_pro_mensual',
          amount: 49900,
          isActive: false,
        }),
      );
      expect(existente.effectiveTo).toBeInstanceOf(Date);
      expect(planPriceRepository.create).not.toHaveBeenCalled();
    });

    /**
     * Idempotencia: la reentrega del mismo evento encuentra la versión activa por
     * `stripe_price_id` y no crea una segunda si sus datos comerciales no cambiaron.
     */
    it('procesar el mismo price.created dos veces no duplica la fila', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      planPriceRepository.findOne.mockResolvedValueOnce(null);
      const price = buildStripePrice();

      await service.syncPriceUpserted(price, buildPlanProduct());
      const creada = planPriceRepository.save.mock.calls[0][0];

      planPriceRepository.findOne.mockResolvedValueOnce(creada);
      await service.syncPriceUpserted(price, buildPlanProduct());

      expect(planPriceRepository.create).toHaveBeenCalledTimes(1);
      // La segunda vez no relevó nada: no hubo versión nueva que publicar.
      expect(planPriceRepository.update).toHaveBeenCalledTimes(1);
    });

    it('ignora un precio no recurrente: plan_prices sólo guarda suscripciones', async () => {
      await service.syncPriceUpserted(
        buildStripePrice({ recurring: null } as Partial<Stripe.Price>),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).not.toHaveBeenCalled();
    });

    it('ignora una periodicidad que el catálogo local no maneja', async () => {
      await service.syncPriceUpserted(
        buildStripePrice({
          recurring: { interval: 'week', interval_count: 1 },
        } as Partial<Stripe.Price>),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).not.toHaveBeenCalled();
    });

    it('ignora un precio sin importe fijo en vez de guardarlo en cero', async () => {
      await service.syncPriceUpserted(
        buildStripePrice({ unit_amount: null }),
        buildPlanProduct(),
      );

      expect(planPriceRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('price.created / price.updated — paquete de documentos', () => {
    it('crea la oferta con los datos del precio y del producto', async () => {
      documentPackOfferRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({
          id: 'price_pack_50',
          unit_amount: 19900,
          product: 'prod_pack',
        }),
        buildPackProduct(),
      );

      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeProductId: 'prod_pack',
          stripePriceId: 'price_pack_50',
          name: 'Paquete de 50 documentos',
          documentsGranted: 50,
          eligiblePlanType: null,
          amount: 19900,
          currency: 'mxn',
          active: true,
        }),
      );
    });

    /**
     * Criterio "los paquetes pueden tener precios distintos según eligible_plan_type": cada
     * combinación paquete + plan + precio es su propia fila, todas bajo el mismo producto.
     */
    it('registra una oferta por plan elegible, sin pisar la del otro plan', async () => {
      planRepository.findOne.mockResolvedValue({ planType: 'pro' });
      documentPackOfferRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({
          id: 'price_pack_50_pro',
          unit_amount: 14900,
          metadata: { eligiblePlanType: 'pro' },
        }),
        buildPackProduct(),
      );

      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeProductId: 'prod_pack',
          stripePriceId: 'price_pack_50_pro',
          eligiblePlanType: 'pro',
          amount: 14900,
        }),
      );
    });

    it('el precio puede declarar sus propios documentsGranted, por encima del producto', async () => {
      documentPackOfferRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ metadata: { documentsGranted: '100' } }),
        buildPackProduct(),
      );

      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ documentsGranted: 100 }),
      );
    });

    it('actualiza la oferta existente del mismo precio en vez de crear otra', async () => {
      const existente = {
        id: 'offer-1',
        stripePriceId: 'price_pack_50',
        documentsGranted: 50,
        amount: 19900,
        active: true,
      };
      documentPackOfferRepository.findOne.mockResolvedValue(existente);

      await service.syncPriceUpserted(
        buildStripePrice({ id: 'price_pack_50', active: false }),
        buildPackProduct(),
      );

      expect(documentPackOfferRepository.create).not.toHaveBeenCalled();
      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'offer-1', active: false }),
      );
    });

    it('un paquete cuyo producto está archivado no queda vendible', async () => {
      documentPackOfferRepository.findOne.mockResolvedValue(null);

      await service.syncPriceUpserted(
        buildStripePrice({ active: true }),
        buildPackProduct({ active: false }),
      );

      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });

    it('lanza si no hay documentsGranted en ningún lado: es justo lo que se vende', async () => {
      await expect(
        service.syncPriceUpserted(
          buildStripePrice(),
          buildPackProduct({ metadata: { catalogType: 'document_pack' } }),
        ),
      ).rejects.toThrow(MissingDocumentPackMetadataException);

      expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
    });

    it('lanza si el plan elegible declarado no existe localmente', async () => {
      planRepository.findOne.mockResolvedValue(null);

      await expect(
        service.syncPriceUpserted(
          buildStripePrice({ metadata: { eligiblePlanType: 'inventado' } }),
          buildPackProduct(),
        ),
      ).rejects.toThrow(UnknownEligiblePlanMetadataException);

      expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('price.created / price.updated — producto ajeno al catálogo', () => {
    it.each([
      ['sin metadata', {}],
      ['con un catalogType no reconocido', { catalogType: 'item' }],
    ])(
      'lo ignora sin tocar ningún repositorio (%s)',
      async (_caso, metadata) => {
        await service.syncPriceUpserted(
          buildStripePrice(),
          buildStripeProduct({ metadata: metadata as Stripe.Metadata }),
        );

        expect(planRepository.save).not.toHaveBeenCalled();
        expect(planPriceRepository.save).not.toHaveBeenCalled();
        expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
      },
    );
  });

  describe('product.deleted — paquete de documentos', () => {
    it('desactiva el document_pack_offer encontrado por stripeProductId, sin borrarlo', async () => {
      await service.syncProductDeleted(
        buildStripeProduct({
          id: 'prod_pack_50',
          metadata: { catalogType: 'document_pack' },
        }),
      );

      expect(documentPackOfferRepository.update).toHaveBeenCalledWith(
        { stripeProductId: 'prod_pack_50' },
        { active: false },
      );
    });

    it('no lanza si no hay ningún paquete vinculado a ese producto', async () => {
      documentPackOfferRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.syncProductDeleted(
          buildStripeProduct({
            id: 'prod_huerfano',
            metadata: { catalogType: 'document_pack' },
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
