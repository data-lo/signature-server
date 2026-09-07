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
    findOne: jest.Mock;
  };

  beforeEach(async () => {
    checkoutOrderRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'order-1', ...data })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue({ id: 'order-1' }),
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
    /**
     * Busca la orden del ALTA —la más antigua que siga sin slot— y sólo esa. En una renovación no
     * hay orden nueva y `credit_slot_id IS NULL` impide que se toque la del periodo anterior.
     */
    it('busca la orden inicial de la suscripción que aún no tenga slot', async () => {
      await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: 'sub_1',
        creditSlotId: 'lot-1',
      });

      expect(checkoutOrderRepository.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          billingProfileId: 'profile-1',
          stripeSubscriptionId: 'sub_1',
          kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
          status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        }),
        order: { createdAt: 'ASC' },
      });
    });

    /**
     * Se actualiza POR ID y se devuelve ese mismo id: el historial guarda en `checkout_order_id`
     * la compra que originó el periodo, y resolverlo por separado arriesgaría que la consulta que
     * escribe y la que reporta eligieran órdenes distintas.
     */
    it('vincula por id y devuelve la orden vinculada', async () => {
      const orderId = await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: 'sub_1',
        creditSlotId: 'lot-1',
      });

      expect(checkoutOrderRepository.update).toHaveBeenCalledWith('order-1', {
        creditSlotId: 'lot-1',
      });
      expect(orderId).toBe('order-1');
    });

    /** Una renovación no pasa por Checkout: no hay nada que vincular y eso no es un fallo. */
    it('devuelve null si no queda ninguna orden sin slot', async () => {
      checkoutOrderRepository.findOne.mockResolvedValue(null);

      const orderId = await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: 'sub_1',
        creditSlotId: 'lot-1',
      });

      expect(orderId).toBeNull();
      expect(checkoutOrderRepository.update).not.toHaveBeenCalled();
    });

    it('no busca vincular una orden si la factura no trae suscripción', async () => {
      const orderId = await service.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: null,
        creditSlotId: 'lot-1',
      });

      expect(orderId).toBeNull();
      expect(checkoutOrderRepository.findOne).not.toHaveBeenCalled();
      expect(checkoutOrderRepository.update).not.toHaveBeenCalled();
    });

    /**
     * Con `manager` el vínculo se escribe DENTRO de la transacción que emitió el lote, que es lo
     * que hace que créditos, historial, perfil y orden queden o no queden los cuatro juntos.
     */
    it('usa el repositorio de la transacción cuando se le pasa un manager', async () => {
      const repositorioTransaccional = {
        findOne: jest.fn().mockResolvedValue({ id: 'order-tx' }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(repositorioTransaccional),
      };

      const orderId = await service.linkCompletedSubscriptionToCreditSlot(
        {
          billingProfileId: 'profile-1',
          stripeSubscriptionId: 'sub_1',
          creditSlotId: 'lot-1',
        },
        manager as never,
      );

      expect(manager.getRepository).toHaveBeenCalledWith(CheckoutOrderEntity);
      expect(repositorioTransaccional.update).toHaveBeenCalledWith('order-tx', {
        creditSlotId: 'lot-1',
      });
      expect(checkoutOrderRepository.update).not.toHaveBeenCalled();
      expect(orderId).toBe('order-tx');
    });
  });
});
