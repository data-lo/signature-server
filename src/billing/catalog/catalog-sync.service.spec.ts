import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import Stripe = require('stripe');
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogItemEntity } from './catalog-item.entity';
import { CatalogPriceEntity } from './catalog-price.entity';
import { DocumentCreditPackEntity } from './document-credit-pack.entity';
import { PlanEntity } from './plan.entity';
import { CATALOG_ITEM_TYPE_ENUM } from '../enums/catalog-item-type.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import { CATALOG_SOURCE_ENUM } from '../enums/catalog-source.enum';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';

function repository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn(async (data) => ({ id: data.id ?? 'generated-id', ...data })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function product(overrides: Partial<Stripe.Product> = {}): Stripe.Product {
  return {
    id: 'prod_1',
    name: 'Premium',
    active: true,
    metadata: {},
    ...overrides,
  } as Stripe.Product;
}

function planProduct(overrides: Partial<Stripe.Product> = {}): Stripe.Product {
  return product({
    metadata: {
      catalogType: 'plan',
      planType: 'premium',
      documentsIncluded: '20',
    },
    ...overrides,
  });
}

function creditProduct(
  overrides: Partial<Stripe.Product> = {},
): Stripe.Product {
  return product({
    id: 'prod_credits',
    name: '50 documentos',
    metadata: { catalogType: 'document_pack', documentsGranted: '50' },
    ...overrides,
  });
}

function price(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_1',
    active: true,
    currency: 'mxn',
    unit_amount: 49900,
    metadata: {},
    recurring: { interval: 'month', interval_count: 1 },
    ...overrides,
  } as Stripe.Price;
}

describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let itemRepository: ReturnType<typeof repository>;
  let priceRepository: ReturnType<typeof repository>;
  let planRepository: ReturnType<typeof repository>;
  let packRepository: ReturnType<typeof repository>;

  beforeEach(async () => {
    itemRepository = repository();
    priceRepository = repository();
    planRepository = repository();
    packRepository = repository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncService,
        {
          provide: getRepositoryToken(CatalogItemEntity),
          useValue: itemRepository,
        },
        {
          provide: getRepositoryToken(CatalogPriceEntity),
          useValue: priceRepository,
        },
        { provide: getRepositoryToken(PlanEntity), useValue: planRepository },
        {
          provide: getRepositoryToken(DocumentCreditPackEntity),
          useValue: packRepository,
        },
      ],
    }).compile();
    service = module.get(CatalogSyncService);
  });

  it('ignora productos sin metadata.catalogType', async () => {
    await service.syncProductUpserted(product());
    expect(itemRepository.save).not.toHaveBeenCalled();
  });

  it('product.created de plan crea catalog_item y plan vinculados', async () => {
    itemRepository.findOne.mockResolvedValue(null);
    planRepository.findOne.mockResolvedValue(null);

    await service.syncProductUpserted(planProduct());

    expect(itemRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
        source: CATALOG_SOURCE_ENUM.STRIPE,
        stripeProductId: 'prod_1',
      }),
    );
    expect(planRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        planType: 'premium',
        catalogItemId: 'generated-id',
        documentsIncluded: 20,
      }),
    );
  });

  it('product.created de créditos crea ítem y detalle sin requerir un precio', async () => {
    itemRepository.findOne.mockResolvedValue(null);
    packRepository.findOne.mockResolvedValue(null);

    await service.syncProductUpserted(creditProduct());

    expect(itemRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
      }),
    );
    expect(packRepository.create).toHaveBeenCalledWith({
      catalogItemId: 'generated-id',
      documentsGranted: 50,
    });
  });

  it('no desactiva un catalog_item manual cuando se elimina su producto de Stripe', async () => {
    itemRepository.findOne.mockResolvedValue({
      id: 'manual-plan-item',
      itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
      source: CATALOG_SOURCE_ENUM.MANUAL,
      isActive: true,
      stripeProductId: 'prod_1',
    });

    await service.syncProductDeleted(planProduct());

    expect(itemRepository.save).not.toHaveBeenCalled();
  });

  it('vincula un plan manual a Stripe sin crear un segundo catalog_item', async () => {
    const manualItem = {
      id: 'manual-plan-item',
      itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
      source: CATALOG_SOURCE_ENUM.MANUAL,
      name: 'Plan configurado internamente',
      isActive: true,
      stripeProductId: null,
    };
    const manualPlan = {
      planType: 'premium',
      catalogItemId: 'manual-plan-item',
      stripeProductId: null,
      creationSource: 'MANUAL',
      name: 'Plan configurado internamente',
      isActive: true,
      documentsIncluded: 99,
    };
    planRepository.findOne.mockResolvedValue(manualPlan);
    itemRepository.findOne.mockResolvedValue(manualItem);

    await service.syncProductUpserted(planProduct());

    expect(itemRepository.create).not.toHaveBeenCalled();
    expect(itemRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'manual-plan-item',
        stripeProductId: 'prod_1',
        name: 'Plan configurado internamente',
      }),
    );
    expect(planRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogItemId: 'manual-plan-item',
        stripeProductId: 'prod_1',
        documentsIncluded: 99,
      }),
    );
  });

  it('price.created de plan asegura ítem, plan y catalog_price recurrente', async () => {
    itemRepository.findOne.mockResolvedValue(null);
    planRepository.findOne.mockResolvedValue(null);
    priceRepository.findOne.mockResolvedValue(null);

    await service.syncPriceUpserted(price(), planProduct());

    expect(planRepository.save).toHaveBeenCalled();
    expect(priceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CATALOG_SOURCE_ENUM.STRIPE,
        stripePriceId: 'price_1',
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
      }),
    );
  });

  it('price.created de créditos completa el detalle y crea catalog_price de pago único', async () => {
    const item = {
      id: 'credit-item',
      source: CATALOG_SOURCE_ENUM.STRIPE,
      itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
    };
    itemRepository.findOne.mockResolvedValue(item);
    packRepository.findOne.mockResolvedValue(null);
    priceRepository.findOne.mockResolvedValue(null);

    await service.syncPriceUpserted(
      price({ recurring: null } as Partial<Stripe.Price>),
      creditProduct(),
    );

    expect(packRepository.create).toHaveBeenCalledWith({
      catalogItemId: 'credit-item',
      documentsGranted: 50,
    });
    expect(priceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogItemId: 'credit-item',
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.ONE_TIME,
        interval: null,
      }),
    );
  });

  it('versiona un precio de plan con el mismo stripePriceId si cambia el importe', async () => {
    const item = {
      id: 'plan-item',
      source: CATALOG_SOURCE_ENUM.STRIPE,
      itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
    };
    const plan = {
      planType: 'premium',
      catalogItemId: 'plan-item',
      stripeProductId: 'prod_1',
      creationSource: 'STRIPE',
      documentsIncluded: 20,
    };
    const currentPrice = {
      id: 'catalog-price-1',
      catalogItemId: 'plan-item',
      eligiblePlanType: null,
      amount: 49900,
      currency: 'mxn',
      billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
      interval: BILLING_INTERVAL_ENUM.MONTH,
      intervalCount: 1,
      isActive: true,
      effectiveTo: null,
    };
    itemRepository.findOne.mockResolvedValue(item);
    planRepository.findOne.mockResolvedValue(plan);
    priceRepository.findOne.mockResolvedValue(currentPrice);

    await service.syncPriceUpserted(
      price({ unit_amount: 59900 }),
      planProduct(),
    );

    expect(priceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'catalog-price-1', isActive: false }),
    );
    expect(priceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stripePriceId: 'price_1',
        amount: 59900,
        isActive: true,
      }),
    );
  });

  it('no permite precio recurrente para créditos', async () => {
    const item = {
      id: 'credit-item',
      source: CATALOG_SOURCE_ENUM.STRIPE,
      itemType: CATALOG_ITEM_TYPE_ENUM.DOCUMENT_CREDIT,
    };
    itemRepository.findOne.mockResolvedValue(item);

    await service.syncPriceUpserted(price(), creditProduct());

    expect(priceRepository.create).not.toHaveBeenCalled();
  });
});
