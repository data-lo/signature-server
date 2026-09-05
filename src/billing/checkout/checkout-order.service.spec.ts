import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CheckoutOrderService } from './checkout-order.service';
import { CheckoutOrderEntity } from './checkout-order.entity';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from '../enums/checkout-order-status.enum';

describe('CheckoutOrderService', () => {
  let service: CheckoutOrderService;
  let checkoutOrderRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    checkoutOrderRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'order-1', ...data })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutOrderService,
        {
          provide: getRepositoryToken(CheckoutOrderEntity),
          useValue: checkoutOrderRepository,
        },
      ],
    }).compile();

    service = module.get(CheckoutOrderService);
  });

  describe('registerPendingSubscription', () => {
    it('registra la orden como SUBSCRIPTION/PENDING con una única oferta de catálogo', async () => {
      await service.registerPendingSubscription({
        billingProfileId: 'profile-1',
        catalogPriceId: 'catalog-price-1',
        stripeCheckoutSessionId: 'cs_1',
        amount: 49900,
        currency: 'mxn',
      });

      expect(checkoutOrderRepository.save).toHaveBeenCalledWith({
        billingProfileId: 'profile-1',
        catalogPriceId: 'catalog-price-1',
        kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: null,
        status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        amount: 49900,
        currency: 'mxn',
      });
    });
  });

  describe('markCompleted', () => {
    it('cierra sólo la orden que sigue PENDING', async () => {
      await service.markCompleted({
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
        stripeSubscriptionId: 'sub_1',
      });

      expect(checkoutOrderRepository.update).toHaveBeenCalledWith(
        {
          stripeCheckoutSessionId: 'cs_1',
          status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        },
        expect.objectContaining({
          status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
          stripePaymentIntentId: 'pi_1',
          stripeSubscriptionId: 'sub_1',
          completedAt: expect.any(Date),
        }),
      );
    });

    /**
     * El `WHERE ... status = PENDING` es lo que hace idempotente la re-entrega: una segunda
     * llegada del mismo evento no vuelve a mover `completed_at`, que dejaría de ser la fecha real
     * del pago.
     */
    it('no lanza cuando no hay ninguna orden PENDING que cerrar', async () => {
      checkoutOrderRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.markCompleted({
          stripeCheckoutSessionId: 'cs_ya_cerrada',
          stripePaymentIntentId: null,
          stripeSubscriptionId: null,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('vínculo con credit_slot', () => {
    it('vincula la orden inicial por suscripción sin reemplazar un slot existente', async () => {
      await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: 'sub_1',
        creditSlotId: 'lot-1',
      });

      expect(checkoutOrderRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          billingProfileId: 'profile-1',
          stripeSubscriptionId: 'sub_1',
          kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
          status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        }),
        { creditSlotId: 'lot-1' },
      );
    });

    it('no busca vincular una orden si la factura no trae suscripción', async () => {
      await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: null,
        creditSlotId: 'lot-1',
      });

      expect(checkoutOrderRepository.update).not.toHaveBeenCalled();
    });
  });
});
