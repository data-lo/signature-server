import { Test, TestingModule } from '@nestjs/testing';
import { StripeWebhookService } from './stripe-webhook.service';
import { CatalogSyncService } from '../../billing/catalog/catalog-sync.service';
import { StripePaymentService } from './stripe-payment.service';
import { RegisterDocumentCreditPurchaseUseCase } from '../../billing/credits/register-document-credit-purchase.use-case';
import { SubscriptionBillingService } from '../../billing/subscriptions/subscription-billing.service';
import Stripe = require('stripe');

/** Producto que el adaptador devuelve al expandir el `product` de un precio. */
const PRODUCTO_DE_PLAN = {
  id: 'prod_pro',
  name: 'Plan Pro',
  active: true,
  metadata: { catalogType: 'plan', planType: 'pro' },
} as unknown as Stripe.Product;

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;
  let catalogSyncService: {
    syncProductUpserted: jest.Mock;
    syncProductDeleted: jest.Mock;
    syncPriceUpserted: jest.Mock;
  };
  let paymentGateway: { retrieveProduct: jest.Mock };
  let subscriptionBillingService: Record<string, jest.Mock>;
  let registerDocumentCreditPurchase: Record<string, jest.Mock>;

  beforeEach(async () => {
    catalogSyncService = {
      syncProductUpserted: jest.fn().mockResolvedValue(undefined),
      syncProductDeleted: jest.fn().mockResolvedValue(undefined),
      syncPriceUpserted: jest.fn().mockResolvedValue(undefined),
    };
    paymentGateway = {
      retrieveProduct: jest.fn().mockResolvedValue(PRODUCTO_DE_PLAN),
    };
    subscriptionBillingService = {
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
      handleInvoicePaid: jest.fn().mockResolvedValue(undefined),
      handleInvoicePaymentFailed: jest.fn().mockResolvedValue(undefined),
      handleSubscriptionUpdated: jest.fn().mockResolvedValue(undefined),
      handleSubscriptionDeleted: jest.fn().mockResolvedValue(undefined),
    };
    registerDocumentCreditPurchase = {
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        { provide: CatalogSyncService, useValue: catalogSyncService },
        { provide: StripePaymentService, useValue: paymentGateway },
        {
          provide: RegisterDocumentCreditPurchaseUseCase,
          useValue: registerDocumentCreditPurchase,
        },
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

  /**
   * Los efectos sobre suscripciones y saldo viven en `billing`: cada evento tiene que llegar a
   * su manejador, o el perfil de facturación se queda desincronizado en silencio.
   */
  describe('enrutado hacia el modelo de billing', () => {
    /**
     * Las compras sueltas de documentos llegan por el MISMO evento, en modo `payment`: el router
     * las entrega a los dos manejadores y cada uno se descarta solo por `session.mode`.
     */
    it('checkout.session.completed llega también a RegisterDocumentCreditPurchaseUseCase', async () => {
      const session = { id: 'cs_1', mode: 'payment', metadata: {} };

      await service.process({
        type: 'checkout.session.completed',
        data: { object: session },
      } as unknown as Stripe.Event);

      expect(
        registerDocumentCreditPurchase.handleCheckoutSessionCompleted,
      ).toHaveBeenCalledWith(session);
    });

    it('checkout.session.completed llega también a SubscriptionBillingService', async () => {
      const session = {
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { billingProfileId: 'profile-1' },
      };

      await service.process({
        type: 'checkout.session.completed',
        data: { object: session },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleCheckoutSessionCompleted,
      ).toHaveBeenCalledWith(session);
    });

    it('invoice.paid llega a SubscriptionBillingService', async () => {
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

    it('invoice.payment_failed llega a SubscriptionBillingService', async () => {
      const invoice = { id: 'in_1', customer: 'cus_1' };

      await service.process({
        type: 'invoice.payment_failed',
        data: { object: invoice },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleInvoicePaymentFailed,
      ).toHaveBeenCalledWith(invoice);
    });

    it('customer.subscription.updated llega a SubscriptionBillingService', async () => {
      const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active' };

      await service.process({
        type: 'customer.subscription.updated',
        data: { object: subscription },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleSubscriptionUpdated,
      ).toHaveBeenCalledWith(subscription);
    });

    it('customer.subscription.deleted llega a SubscriptionBillingService', async () => {
      const subscription = { id: 'sub_1', customer: 'cus_1' };

      await service.process({
        type: 'customer.subscription.deleted',
        data: { object: subscription },
      } as unknown as Stripe.Event);

      expect(
        subscriptionBillingService.handleSubscriptionDeleted,
      ).toHaveBeenCalledWith(subscription);
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
      const product = {
        id: 'prod_1',
        name: 'Plan Pro',
        active: true,
        metadata: {},
      };

      await service.process({
        type: 'product.created',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductUpserted).toHaveBeenCalledWith(
        product,
      );
      expect(catalogSyncService.syncProductDeleted).not.toHaveBeenCalled();
    });

    it('product.updated delega en catalogSyncService.syncProductUpserted', async () => {
      const product = {
        id: 'prod_1',
        name: 'Plan Pro (renombrado)',
        active: true,
        metadata: {},
      };

      await service.process({
        type: 'product.updated',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductUpserted).toHaveBeenCalledWith(
        product,
      );
    });

    it('product.deleted delega en catalogSyncService.syncProductDeleted', async () => {
      const product = {
        id: 'prod_1',
        name: 'Plan Pro',
        active: false,
        metadata: {},
      };

      await service.process({
        type: 'product.deleted',
        data: { object: product },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncProductDeleted).toHaveBeenCalledWith(
        product,
      );
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

  /**
   * Historia "Sincronizar productos y precios de Stripe con el catálogo local". Igual que con los
   * eventos de producto, aquí sólo se prueba el ENRUTADO: qué se escribe en `plan_prices` o en
   * `document_pack_offers` vive en `CatalogSyncService` y se prueba en su propio spec.
   */
  describe('price.created / price.updated', () => {
    const price = {
      id: 'price_pro_mensual',
      active: true,
      currency: 'mxn',
      unit_amount: 49900,
      product: 'prod_pro',
      recurring: { interval: 'month', interval_count: 1 },
    } as unknown as Stripe.Price;

    it.each(['price.created', 'price.updated'])(
      '%s delega en catalogSyncService.syncPriceUpserted con el producto ya expandido',
      async (type) => {
        await service.process({
          type,
          data: { object: price },
        } as unknown as Stripe.Event);

        expect(paymentGateway.retrieveProduct).toHaveBeenCalledWith('prod_pro');
        expect(catalogSyncService.syncPriceUpserted).toHaveBeenCalledWith(
          price,
          PRODUCTO_DE_PLAN,
        );
      },
    );

    /** Si Stripe alguna vez lo mandara expandido, no hace falta ir a buscarlo. */
    it('usa el producto del propio payload cuando ya viene expandido', async () => {
      const expandido = {
        ...price,
        product: PRODUCTO_DE_PLAN,
      } as unknown as Stripe.Price;

      await service.process({
        type: 'price.created',
        data: { object: expandido },
      } as unknown as Stripe.Event);

      expect(paymentGateway.retrieveProduct).not.toHaveBeenCalled();
      expect(catalogSyncService.syncPriceUpserted).toHaveBeenCalledWith(
        expandido,
        PRODUCTO_DE_PLAN,
      );
    });

    /**
     * `plan.created` es el objeto heredado que Stripe reemplazó por `price`: atenderlo duplicaría
     * cada alta de precio en el catálogo local.
     */
    it('no procesa plan.created', async () => {
      await service.process({
        type: 'plan.created',
        data: { object: { id: 'plan_viejo' } },
      } as unknown as Stripe.Event);

      expect(catalogSyncService.syncPriceUpserted).not.toHaveBeenCalled();
      expect(paymentGateway.retrieveProduct).not.toHaveBeenCalled();
    });

    it('propaga el error de la sincronización para que Stripe reintente la entrega', async () => {
      catalogSyncService.syncPriceUpserted.mockRejectedValue(
        new Error('metadata inválida'),
      );

      await expect(
        service.process({
          type: 'price.created',
          data: { object: price },
        } as unknown as Stripe.Event),
      ).rejects.toThrow('metadata inválida');
    });
  });
});
