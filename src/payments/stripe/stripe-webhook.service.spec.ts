import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StripeWebhookService } from './stripe-webhook.service';
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { CatalogSyncService } from '../../billing/catalog/catalog-sync.service';
import { SubscriptionBillingService } from '../../billing/subscriptions/subscription-billing.service';
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
  let catalogSyncService: { syncProductUpserted: jest.Mock; syncProductDeleted: jest.Mock };
  let subscriptionBillingService: Record<string, jest.Mock>;

  beforeEach(async () => {
    subscriptionRepository = createMockRepository();
    catalogSyncService = {
      syncProductUpserted: jest.fn().mockResolvedValue(undefined),
      syncProductDeleted: jest.fn().mockResolvedValue(undefined),
    };
    subscriptionBillingService = {
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
      handleInvoicePaid: jest.fn().mockResolvedValue(undefined),
      handleInvoicePaymentFailed: jest.fn().mockResolvedValue(undefined),
      handleSubscriptionUpdated: jest.fn().mockResolvedValue(undefined),
      handleSubscriptionDeleted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: subscriptionRepository,
        },
        { provide: CatalogSyncService, useValue: catalogSyncService },
        {
          provide: SubscriptionBillingService,
          useValue: subscriptionBillingService,
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

  /**
   * Conviven dos modelos de suscripción (ver el docblock de `StripeWebhookService`): el heredado
   * en `account_subscriptions` y el nuevo en `billing_profiles`. Los eventos compartidos tienen
   * que llegar a los dos, o uno de los dos se queda desincronizado en silencio.
   */
  describe('enrutado hacia el modelo de billing', () => {
    it('checkout.session.completed llega también a SubscriptionBillingService', async () => {
      subscriptionRepository.findOne.mockResolvedValue(null);
      const session = {
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { accountId: 'account-1', billingProfileId: 'profile-1' },
      };

      await service.process({
        type: 'checkout.session.completed',
        data: { object: session },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleCheckoutSessionCompleted,
      ).toHaveBeenCalledWith(session);
      // Y el modelo heredado sigue atendiéndose.
      expect(subscriptionRepository.save).toHaveBeenCalled();
    });

    it('invoice.paid llega también a SubscriptionBillingService', async () => {
      subscriptionRepository.findOne.mockResolvedValue({ id: 'row-1' });
      const invoice = {
        customer: 'cus_1',
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: { data: [{ period: { end: 1700000000 } }] },
      };

      await service.process({
        type: 'invoice.paid',
        data: { object: invoice },
      } as unknown as Stripe.Event);

      expect(subscriptionBillingService.handleInvoicePaid).toHaveBeenCalledWith(
        invoice,
      );
    });

    it('invoice.payment_failed se enruta (evento nuevo, sin equivalente heredado)', async () => {
      const invoice = { id: 'in_1', customer: 'cus_1' };

      await service.process({
        type: 'invoice.payment_failed',
        data: { object: invoice },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleInvoicePaymentFailed,
      ).toHaveBeenCalledWith(invoice);
    });

    it('customer.subscription.updated se enruta (evento nuevo, sin equivalente heredado)', async () => {
      const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active' };

      await service.process({
        type: 'customer.subscription.updated',
        data: { object: subscription },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleSubscriptionUpdated,
      ).toHaveBeenCalledWith(subscription);
    });

    it('customer.subscription.deleted llega a los dos modelos', async () => {
      subscriptionRepository.findOne.mockResolvedValue({ id: 'row-1' });
      const subscription = { id: 'sub_1', customer: 'cus_1' };

      await service.process({
        type: 'customer.subscription.deleted',
        data: { object: subscription },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleSubscriptionDeleted,
      ).toHaveBeenCalledWith(subscription);
      expect(subscriptionRepository.update).toHaveBeenCalled();
    });
  });

  it('loguea (sin lanzar) eventos de Stripe no manejados', async () => {
    await expect(
      service.process({ type: 'payment_intent.created' } as Stripe.Event),
    ).resolves.toBeUndefined();
  });

  /**
   * Sólo se prueba que `StripeWebhookService` DELEGA correctamente — la lógica de a qué tabla
   * del catálogo pertenece cada producto, cómo se hace el upsert y qué se conserva vive en
   * `CatalogSyncService` y se prueba en su propio spec.
   */
  describe('product.created / product.updated / product.deleted', () => {
    it('product.created delega en catalogSyncService.syncProductUpserted', async () => {
      const product = { id: 'prod_1', name: 'Plan Pro', active: true, metadata: {} };

      await service.process({
        type: 'product.created',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductUpserted).toHaveBeenCalledWith(product);
      expect(catalogSyncService.syncProductDeleted).not.toHaveBeenCalled();
    });

    it('product.updated delega en catalogSyncService.syncProductUpserted', async () => {
      const product = { id: 'prod_1', name: 'Plan Pro (renombrado)', active: true, metadata: {} };

      await service.process({
        type: 'product.updated',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductUpserted).toHaveBeenCalledWith(product);
    });

    it('product.deleted delega en catalogSyncService.syncProductDeleted', async () => {
      const product = { id: 'prod_1', name: 'Plan Pro', active: false, metadata: {} };

      await service.process({
        type: 'product.deleted',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductDeleted).toHaveBeenCalledWith(product);
      expect(catalogSyncService.syncProductUpserted).not.toHaveBeenCalled();
    });

    it('propaga el error de la sincronización para que la entrega quede FAILED y Stripe reintente', async () => {
      catalogSyncService.syncProductUpserted.mockRejectedValue(
        new Error('falla de sincronización'),
      );

      await expect(
        service.process({
          type: 'product.created',
          data: { object: { id: 'prod_1', metadata: {} } },
        } as unknown as Stripe.Event),
      ).rejects.toThrow('falla de sincronización');
    });
  });
});
