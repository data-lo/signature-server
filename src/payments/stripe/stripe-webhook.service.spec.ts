import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StripeWebhookService } from './stripe-webhook.service';
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import Stripe = require('stripe');

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(),
    update: jest.fn(),
  };
}

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;
  let subscriptionRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    subscriptionRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: subscriptionRepository,
        },
      ],
    }).compile();

    service = module.get<StripeWebhookService>(StripeWebhookService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkout.session.completed', () => {
    it('crea la suscripción como INCOMPLETE con customerId/subscriptionId de Stripe', async () => {
      subscriptionRepository.findOne.mockResolvedValue(null);

      await service.process({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            customer: 'cus_1',
            subscription: 'sub_1',
            metadata: { accountId: 'account-1', planId: PLAN_ID_ENUM.PRO },
          },
        },
      } as unknown as Stripe.Event);

      expect(subscriptionRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'account-1',
          planId: PLAN_ID_ENUM.PRO,
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          status: SUBSCRIPTION_STATUS_ENUM.INCOMPLETE,
        }),
      );
    });

    it('ignora el evento si no viene accountId en metadata o el modo no es subscription', async () => {
      await service.process({
        type: 'checkout.session.completed',
        data: {
          object: { mode: 'payment', customer: 'cus_1', metadata: {} },
        },
      } as unknown as Stripe.Event);

      expect(subscriptionRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('invoice.paid', () => {
    it('activa la suscripción encontrada por stripeSubscriptionId', async () => {
      subscriptionRepository.findOne.mockResolvedValue({
        id: 'subscription-row-1',
        stripeSubscriptionId: 'sub_1',
      });

      await service.process({
        type: 'invoice.paid',
        data: {
          object: {
            customer: 'cus_1',
            parent: { subscription_details: { subscription: 'sub_1' } },
            lines: { data: [{ period: { end: 1700000000 } }] },
          },
        },
      } as unknown as Stripe.Event);

      expect(subscriptionRepository.findOne).toHaveBeenCalledWith({
        where: { stripeSubscriptionId: 'sub_1' },
      });
      expect(subscriptionRepository.update).toHaveBeenCalledWith(
        'subscription-row-1',
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS_ENUM.ACTIVE,
          signingEnabled: true,
        }),
      );
    });

    it('bug corregido: cae al fallback por stripeCustomerId si invoice.paid llega antes que checkout.session.completed haya grabado el stripeSubscriptionId localmente', async () => {
      // La fila local todavía no tiene stripeSubscriptionId (checkout.session.completed no ha
      // llegado todavía) — la búsqueda por stripeSubscriptionId no encuentra nada, así que debe
      // caer al fallback por stripeCustomerId en vez de rendirse ahí mismo.
      subscriptionRepository.findOne
        .mockResolvedValueOnce(null) // búsqueda por stripeSubscriptionId: no encontrada
        .mockResolvedValueOnce({
          id: 'subscription-row-1',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: null,
        }); // fallback por stripeCustomerId: sí encontrada

      await service.process({
        type: 'invoice.paid',
        data: {
          object: {
            customer: 'cus_1',
            parent: { subscription_details: { subscription: 'sub_1' } },
            lines: { data: [{ period: { end: 1700000000 } }] },
          },
        },
      } as unknown as Stripe.Event);

      expect(subscriptionRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { stripeSubscriptionId: 'sub_1' },
      });
      expect(subscriptionRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { stripeCustomerId: 'cus_1' },
      });
      // Debe activarse Y backfillear el stripeSubscriptionId que faltaba, para que la próxima
      // vez ya no dependa del fallback.
      expect(subscriptionRepository.update).toHaveBeenCalledWith(
        'subscription-row-1',
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS_ENUM.ACTIVE,
          signingEnabled: true,
          stripeSubscriptionId: 'sub_1',
        }),
      );
    });

    it('no lanza error si no encuentra ninguna suscripción por ninguno de los dos criterios', async () => {
      subscriptionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.process({
          type: 'invoice.paid',
          data: {
            object: {
              customer: 'cus-huerfano',
              parent: {},
              lines: { data: [] },
            },
          },
        } as unknown as Stripe.Event),
      ).resolves.toBeUndefined();
      expect(subscriptionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('customer.subscription.deleted', () => {
    it('cancela la suscripción encontrada', async () => {
      subscriptionRepository.findOne.mockResolvedValue({
        id: 'subscription-row-1',
      });

      await service.process({
        type: 'customer.subscription.deleted',
        data: {
          object: { id: 'sub_1', customer: 'cus_1' },
        },
      } as unknown as Stripe.Event);

      expect(subscriptionRepository.update).toHaveBeenCalledWith(
        'subscription-row-1',
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS_ENUM.CANCELED,
          signingEnabled: false,
        }),
      );
    });
  });

  it('loguea (sin lanzar) eventos de Stripe no manejados', async () => {
    await expect(
      service.process({ type: 'payment_intent.created' } as Stripe.Event),
    ).resolves.toBeUndefined();
  });
});
