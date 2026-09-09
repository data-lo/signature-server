import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingCatalogService } from './billing-catalog.service';
import { CatalogPriceEntity } from './catalog-price.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import {
  DocumentCreditOfferNotAvailableException,
  SubscriptionPriceNotAvailableException,
} from '../exceptions/billing.exceptions';
import { CATALOG_ITEM_TYPE_ENUM } from '../enums/catalog-item-type.enum';
import { CATALOG_SCOPE_SUBJECT_TYPE_ENUM } from '../enums/catalog-scope-subject-type.enum';

function buildPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-price-1',
    stripePriceId: 'price_premium_monthly',
    amount: 49900,
    currency: 'mxn',
    billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
    interval: BILLING_INTERVAL_ENUM.MONTH,
    intervalCount: 1,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    catalogItem: {
      isActive: true,
      plan: { planType: 'premium', isActive: true, documentsIncluded: 20 },
    },
    ...overrides,
  };
}


/** Un paquete de documentos del catálogo local, ya vendible salvo que la prueba lo estropee. */
function buildCreditPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-price-credits-1',
    stripePriceId: 'price_extra_doc',
    amount: 3900,
    currency: 'mxn',
    billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME,
    interval: null,
    intervalCount: null,
    eligiblePlanType: 'free',
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    catalogItemId: 'catalog-item-1',
    catalogItem: {
      id: 'catalog-item-1',
      name: 'Documento adicional',
      isActive: true,
      itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
      documentCreditPack: { documentsGranted: 1 },
      scopes: [],
    },
    ...overrides,
  };
}

describe('BillingCatalogService', () => {
  let service: BillingCatalogService;
  const catalogPriceRepository = { findOne: jest.fn(), find: jest.fn() };

  beforeEach(async () => {
    catalogPriceRepository.findOne.mockReset();
    catalogPriceRepository.find.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingCatalogService,
        {
          provide: getRepositoryToken(CatalogPriceEntity),
          useValue: catalogPriceRepository,
        },
      ],
    }).compile();
    service = module.get(BillingCatalogService);
  });

  const personalOwner = {
    personalAccountId: 'account-1',
    organizationId: null,
  };

  it('obtiene una oferta recurrente activa con su plan', async () => {
    const price = buildPrice();
    catalogPriceRepository.findOne.mockResolvedValue(price);

    await expect(
      service.findSellableRecurringPrice('price_premium_monthly', personalOwner),
    ).resolves.toBe(price);

    expect(catalogPriceRepository.findOne).toHaveBeenCalledWith({
      where: {
        stripePriceId: 'price_premium_monthly',
        isActive: true,
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
      },
      relations: { catalogItem: { plan: true, scopes: true } },
      order: { effectiveFrom: 'DESC' },
    });
  });

  it('rechaza un precio inexistente, inactivo o cuyo plan está dado de baja', async () => {
    catalogPriceRepository.findOne.mockResolvedValue(null);
    await expect(service.findSellableRecurringPrice('price_missing', personalOwner)).rejects.toThrow(
      SubscriptionPriceNotAvailableException,
    );

    catalogPriceRepository.findOne.mockResolvedValue(
      buildPrice({ catalogItem: { isActive: false, plan: { isActive: true } } }),
    );
    await expect(service.findSellableRecurringPrice('price_archived', personalOwner)).rejects.toThrow(
      SubscriptionPriceNotAvailableException,
    );
  });

  it('conserva la búsqueda laxa para una factura histórica', async () => {
    const price = buildPrice({ isActive: false });
    catalogPriceRepository.findOne.mockResolvedValue(price);

    await expect(service.findPriceForInvoice('price_premium_monthly')).resolves.toBe(
      price,
    );
    expect(catalogPriceRepository.findOne).toHaveBeenLastCalledWith({
      where: { stripePriceId: 'price_premium_monthly' },
      relations: { catalogItem: { plan: true } },
      order: { effectiveFrom: 'DESC' },
    });
  });

  it('impide comprar un ítem restringido desde otro owner', async () => {
    catalogPriceRepository.findOne.mockResolvedValue(
      buildPrice({
        catalogItem: {
          isActive: true,
          plan: { planType: 'premium', isActive: true },
          scopes: [
            {
              subjectType: CATALOG_SCOPE_SUBJECT_TYPE_ENUM.ORGANIZATION,
              subjectId: 'organization-1',
            },
          ],
        },
      }),
    );

    await expect(
      service.findSellableRecurringPrice('price_premium_monthly', personalOwner),
    ).rejects.toThrow(SubscriptionPriceNotAvailableException);

    await expect(
      service.findSellableRecurringPrice('price_premium_monthly', {
        personalAccountId: null,
        organizationId: 'organization-1',
      }),
    ).resolves.toBeDefined();
  });

  /**
   * La regla comercial central de "comprar documentos adicionales": el plan no filtra qué se ve,
   * DECIDE el precio. La misma oferta vale distinto en Free, Plus y Premium.
   */
  describe('paquetes de documentos disponibles', () => {
    it('consulta sólo paquetes activos, de pago único y del plan indicado', async () => {
      catalogPriceRepository.find.mockResolvedValue([buildCreditPrice()]);

      await service.findAvailableDocumentCreditPrices('free', personalOwner);

      expect(catalogPriceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
            billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME,
            eligiblePlanType: 'free',
            catalogItem: expect.objectContaining({
              isActive: true,
              itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
            }),
          }),
        }),
      );
    });

    it('devuelve el paquete de Free con sus documentos y su importe', async () => {
      const price = buildCreditPrice();
      catalogPriceRepository.find.mockResolvedValue([price]);

      await expect(
        service.findAvailableDocumentCreditPrices('free', personalOwner),
      ).resolves.toEqual([price]);
    });

    /**
     * Un ítem marcado como paquete pero sin su fila en `document_credit_packs` no dice cuántos
     * documentos concede: ofrecerlo sería vender una cantidad inventada.
     */
    it('descarta el ítem que no declara cuántos documentos concede', async () => {
      catalogPriceRepository.find.mockResolvedValue([
        buildCreditPrice({
          catalogItem: {
            ...buildCreditPrice().catalogItem,
            documentCreditPack: null,
          },
        }),
      ]);

      await expect(
        service.findAvailableDocumentCreditPrices('free', personalOwner),
      ).resolves.toEqual([]);
    });

    it('descarta el paquete fuera de su ventana de vigencia', async () => {
      catalogPriceRepository.find.mockResolvedValue([
        buildCreditPrice({ effectiveTo: new Date(Date.now() - 1000) }),
      ]);

      await expect(
        service.findAvailableDocumentCreditPrices('free', personalOwner),
      ).resolves.toEqual([]);
    });

    it('descarta el paquete cuyo scope es de otro propietario', async () => {
      catalogPriceRepository.find.mockResolvedValue([
        buildCreditPrice({
          catalogItem: {
            ...buildCreditPrice().catalogItem,
            scopes: [
              {
                subjectType: CATALOG_SCOPE_SUBJECT_TYPE_ENUM.ORGANIZATION,
                subjectId: 'otra-org',
              },
            ],
          },
        }),
      ]);

      await expect(
        service.findAvailableDocumentCreditPrices('free', personalOwner),
      ).resolves.toEqual([]);
    });

    /** Un plan sin paquetes configurados es un estado normal del catálogo, no un error. */
    it('un plan sin paquetes devuelve una lista vacía', async () => {
      catalogPriceRepository.find.mockResolvedValue([]);

      await expect(
        service.findAvailableDocumentCreditPrices('premium', personalOwner),
      ).resolves.toEqual([]);
    });
  });

  /**
   * La validación que se aplica al COMPRAR, y la que sostiene "no se puede comprar un paquete
   * incompatible manipulando el catalogPriceId".
   */
  describe('validación de un paquete al comprarlo', () => {
    const rechaza = (price: unknown, planType = 'free') => {
      catalogPriceRepository.findOne.mockResolvedValue(price);

      return expect(
        service.findSellableDocumentCreditPrice(
          'catalog-price-credits-1',
          planType,
          personalOwner,
        ),
      ).rejects.toThrow(DocumentCreditOfferNotAvailableException);
    };

    it('acepta el paquete que corresponde al plan vigente', async () => {
      const price = buildCreditPrice();
      catalogPriceRepository.findOne.mockResolvedValue(price);

      await expect(
        service.findSellableDocumentCreditPrice(
          'catalog-price-credits-1',
          'free',
          personalOwner,
        ),
      ).resolves.toBe(price);
    });

    /** El caso explícito de la historia: no comprar el paquete de Premium desde una cuenta Free. */
    it('rechaza el paquete de Premium pedido desde una cuenta Free', async () => {
      await rechaza(buildCreditPrice({ eligiblePlanType: 'premium' }), 'free');
    });

    it('rechaza un paquete sin plan elegible', async () => {
      await rechaza(buildCreditPrice({ eligiblePlanType: null }));
    });

    it('rechaza un precio inactivo', async () => {
      await rechaza(buildCreditPrice({ isActive: false }));
    });

    it('rechaza un precio cuyo ítem está dado de baja', async () => {
      await rechaza(
        buildCreditPrice({
          catalogItem: { ...buildCreditPrice().catalogItem, isActive: false },
        }),
      );
    });

    /** Un plan es recurrente: comprarlo por esta vía saltaría toda la lógica de suscripción. */
    it('rechaza un precio recurrente', async () => {
      await rechaza(
        buildCreditPrice({
          billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
        }),
      );
    });

    it('rechaza un ítem que no es un paquete de documentos', async () => {
      await rechaza(
        buildCreditPrice({
          catalogItem: {
            ...buildCreditPrice().catalogItem,
            itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
          },
        }),
      );
    });

    it('rechaza un precio que no existe', async () => {
      await rechaza(null);
    });

    it('rechaza un paquete fuera de su ventana de vigencia', async () => {
      await rechaza(buildCreditPrice({ effectiveFrom: new Date(Date.now() + 60_000) }));
    });
  });

});
