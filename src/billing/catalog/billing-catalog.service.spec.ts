import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingCatalogService } from './billing-catalog.service';
import { PlanPriceEntity } from './plan-price.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { SubscriptionPriceNotAvailableException } from '../exceptions/billing.exceptions';

function buildPlanPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-price-1',
    planType: 'pro',
    stripePriceId: 'price_pro_mensual',
    amount: 49900,
    currency: 'mxn',
    interval: BILLING_INTERVAL_ENUM.MONTH,
    intervalCount: 1,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    plan: { planType: 'pro', isActive: true, documentsIncluded: 100 },
    ...overrides,
  };
}

describe('BillingCatalogService', () => {
  let service: BillingCatalogService;
  let planPriceRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    planPriceRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingCatalogService,
        {
          provide: getRepositoryToken(PlanPriceEntity),
          useValue: planPriceRepository,
        },
      ],
    }).compile();

    service = module.get(BillingCatalogService);
  });

  describe('findSellableRecurringPrice', () => {
    it('devuelve el precio con su plan cuando todo está vigente', async () => {
      const price = buildPlanPrice();
      planPriceRepository.findOne.mockResolvedValue(price);

      await expect(
        service.findSellableRecurringPrice('price_pro_mensual'),
      ).resolves.toBe(price);

      expect(planPriceRepository.findOne).toHaveBeenCalledWith({
        where: { stripePriceId: 'price_pro_mensual', isActive: true },
        relations: { plan: true },
        order: { effectiveFrom: 'DESC' },
      });
    });

    /**
     * Un precio de paquete de documentos vive en `document_pack_offers`, no acá: no aparecer en
     * `plan_prices` ES la comprobación de que el precio no es recurrente.
     */
    it('rechaza un precio que no está en plan_prices (inexistente o de pago único)', async () => {
      planPriceRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findSellableRecurringPrice('price_paquete_50'),
      ).rejects.toThrow(SubscriptionPriceNotAvailableException);
    });

    it('rechaza un precio archivado', async () => {
      planPriceRepository.findOne.mockResolvedValue(
        buildPlanPrice({ isActive: false }),
      );

      await expect(
        service.findSellableRecurringPrice('price_pro_mensual'),
      ).rejects.toThrow(SubscriptionPriceNotAvailableException);
    });

    it('rechaza un precio cuyo plan está dado de baja', async () => {
      planPriceRepository.findOne.mockResolvedValue(
        buildPlanPrice({ plan: { planType: 'pro', isActive: false } }),
      );

      await expect(
        service.findSellableRecurringPrice('price_pro_mensual'),
      ).rejects.toThrow(SubscriptionPriceNotAvailableException);
    });

    it('rechaza un precio que todavía no entra en vigor', async () => {
      planPriceRepository.findOne.mockResolvedValue(
        buildPlanPrice({ effectiveFrom: new Date(Date.now() + 86_400_000) }),
      );

      await expect(
        service.findSellableRecurringPrice('price_pro_mensual'),
      ).rejects.toThrow(SubscriptionPriceNotAvailableException);
    });

    it('rechaza un precio cuya vigencia ya venció', async () => {
      planPriceRepository.findOne.mockResolvedValue(
        buildPlanPrice({ effectiveTo: new Date(Date.now() - 86_400_000) }),
      );

      await expect(
        service.findSellableRecurringPrice('price_pro_mensual'),
      ).rejects.toThrow(SubscriptionPriceNotAvailableException);
    });
  });

  /**
   * Al facturar se es deliberadamente más laxo: si el plan se archivó entre la contratación y la
   * renovación, el cliente pagó igual y le tocan sus documentos.
   */
  describe('findPriceForInvoice', () => {
    it('devuelve el precio aunque esté archivado y su plan dado de baja', async () => {
      const price = buildPlanPrice({
        isActive: false,
        plan: { planType: 'pro', isActive: false, documentsIncluded: 100 },
      });
      planPriceRepository.findOne.mockResolvedValue(price);

      await expect(
        service.findPriceForInvoice('price_pro_mensual'),
      ).resolves.toBe(price);
    });

    it('devuelve null si el precio no está en el catálogo local', async () => {
      planPriceRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findPriceForInvoice('price_desconocido'),
      ).resolves.toBeNull();
    });
  });
});
