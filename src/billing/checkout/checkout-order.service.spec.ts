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
    it('registra la orden como SUBSCRIPTION/PENDING sin oferta de paquete', async () => {
      await service.registerPendingSubscription({
        billingProfileId: 'profile-1',
        planPriceId: 'plan-price-1',
        stripeCheckoutSessionId: 'cs_1',
        amount: 49900,
        currency: 'mxn',
      });

      expect(checkoutOrderRepository.save).toHaveBeenCalledWith({
        billingProfileId: 'profile-1',
        planPriceId: 'plan-price-1',
        // La tabla exige exactamente uno de los dos artículos según el `kind`
        // (`CHK_checkout_orders_item_matches_kind`).
        documentPackOfferId: null,
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
      });

      expect(checkoutOrderRepository.update).toHaveBeenCalledWith(
        {
          stripeCheckoutSessionId: 'cs_1',
          status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        },
        expect.objectContaining({
          status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
          stripePaymentIntentId: 'pi_1',
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
        }),
      ).resolves.toBeUndefined();
    });
  });
});
