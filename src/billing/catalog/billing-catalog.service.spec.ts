import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingCatalogService } from './billing-catalog.service';
import { CatalogPriceEntity } from './catalog-price.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import { SubscriptionPriceNotAvailableException } from '../exceptions/billing.exceptions';
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

describe('BillingCatalogService', () => {
  let service: BillingCatalogService;
  const catalogPriceRepository = { findOne: jest.fn() };

  beforeEach(async () => {
    catalogPriceRepository.findOne.mockReset();
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
});
