import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import Stripe = require('stripe');
import { CatalogSyncService } from './catalog-sync.service';
import { PlanEntity } from './plan.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { MissingPlanCodeMetadataException } from './exceptions/catalog-sync.exceptions';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
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

describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let planRepository: ReturnType<typeof createMockRepository>;
  let documentPackOfferRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    planRepository = createMockRepository();
    documentPackOfferRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncService,
        { provide: getRepositoryToken(PlanEntity), useValue: planRepository },
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
          metadata: { catalogType: 'plan', planCode: 'pro' },
        }),
      );

      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'pro',
          name: 'Plan Pro',
          active: true,
          stripeProductId: 'prod_pro',
          monthlyDocumentLimit: 1,
          allowSimpleSignature: true,
          allowAdvancedSignature: false,
        }),
      );
    });

    it('sincroniza nombre/activo/stripeProductId SIN tocar los límites comerciales de una fila existente', async () => {
      const existingPlan = {
        code: 'pro',
        name: 'Plan Pro (viejo)',
        active: true,
        stripeProductId: null,
        monthlyDocumentLimit: 500,
        allowSimpleSignature: true,
        allowAdvancedSignature: true,
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
          metadata: { catalogType: 'plan', planCode: 'pro' },
        }),
      );

      expect(planRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { stripeProductId: 'prod_pro' },
      });
      expect(planRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { code: 'pro' },
      });
      expect(planRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'pro',
          name: 'Plan Pro',
          active: true,
          stripeProductId: 'prod_pro',
          // Estos tres NO vienen del producto de Stripe — deben quedar exactamente como estaban.
          monthlyDocumentLimit: 500,
          allowSimpleSignature: true,
          allowAdvancedSignature: true,
        }),
      );
    });

    it('lanza si el producto se marca como plan sin metadata.planCode', async () => {
      await expect(
        service.syncProductUpserted(
          buildStripeProduct({ metadata: { catalogType: 'plan' } }),
        ),
      ).rejects.toThrow(MissingPlanCodeMetadataException);

      expect(planRepository.save).not.toHaveBeenCalled();
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
        metadata: { catalogType: 'plan', planCode: 'pro' },
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
          metadata: { catalogType: 'plan', planCode: 'pro' },
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
            metadata: { catalogType: 'plan', planCode: 'pro' },
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('product.created / product.updated — paquete de documentos', () => {
    it('sincroniza nombre/activo de un document_pack_offer ya vinculado, SIN tocar precio/documentos', async () => {
      const existingOffer = {
        id: 'offer-1',
        name: 'Paquete viejo',
        active: true,
        stripeProductId: 'prod_pack_50',
        stripePriceId: 'price_pack_50',
        documentsGranted: 50,
        amount: 49900,
        currency: 'mxn',
      };
      documentPackOfferRepository.findOne.mockResolvedValue(existingOffer);

      await service.syncProductUpserted(
        buildStripeProduct({
          id: 'prod_pack_50',
          name: 'Paquete de 50 documentos',
          active: true,
          metadata: { catalogType: 'document_pack' },
        }),
      );

      expect(documentPackOfferRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'offer-1',
          name: 'Paquete de 50 documentos',
          active: true,
          // Datos del PRECIO, no del producto — deben quedar intactos.
          stripePriceId: 'price_pack_50',
          documentsGranted: 50,
          amount: 49900,
          currency: 'mxn',
        }),
      );
    });

    it('NO crea un document_pack_offer nuevo sin fila local previa (faltan datos del precio)', async () => {
      documentPackOfferRepository.findOne.mockResolvedValue(null);

      await service.syncProductUpserted(
        buildStripeProduct({
          id: 'prod_pack_nuevo',
          metadata: { catalogType: 'document_pack' },
        }),
      );

      expect(documentPackOfferRepository.create).not.toHaveBeenCalled();
      expect(documentPackOfferRepository.save).not.toHaveBeenCalled();
    });
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
