import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Stripe = require('stripe');
import { ReceiveStripeWebhookUseCase } from 'src/webhooks/applications/receive-stripe-webhook.use-case';
import { RegisterWebhookEventUseCase } from 'src/webhooks/applications/register-webhook-event.use-case';
import { StripeWebhookSignatureVerifierService } from 'src/webhooks/stripe/stripe-webhook-signature-verifier.service';
import { WebhookEventEntity } from 'src/webhooks/entities/webhook-event.entity';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from 'src/webhooks/enums/webhook-processing-status.enum';
import { StripeWebhookService } from 'src/payments/stripe/stripe-webhook.service';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { AccountSubscriptionEntity } from 'src/payments/entities/account-subscription.entity';
import { SubscriptionBillingService } from './subscription-billing.service';
import { RegisterSubscriptionBillingUseCase } from './register-subscription-billing.use-case';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CatalogSyncService } from '../catalog/catalog-sync.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CatalogItemEntity } from '../catalog/catalog-item.entity';
import { CatalogPriceEntity } from '../catalog/catalog-price.entity';
import { DocumentCreditPackEntity } from '../catalog/document-credit-pack.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from '../enums/checkout-order-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z

function createMockRepository() {
  return {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'generated-id', ...data })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

/**
 * Recorrido completo de una entrega de Stripe, sin dobles entre capas:
 * `ReceiveStripeWebhookUseCase` (idempotencia + estado de la entrega) →
 * `StripeWebhookService` (enrutado) → `SubscriptionBillingService` (efecto económico).
 *
 * Lo que se sustituye es únicamente lo que sale del proceso: la base de datos y la verificación
 * de firma (que tiene su propio spec y exige el secreto real). El objetivo es cazar justo los
 * fallos que un spec por unidad no ve — un evento que nadie enruta, un `markProcessed` que no
 * llega, o un efecto que ocurre pese a que la entrega era duplicada.
 */
describe('Suscripción recurrente — flujo de webhooks (integración)', () => {
  let receiveStripeWebhook: ReceiveStripeWebhookUseCase;
  let webhookEventRepository: ReturnType<typeof createMockRepository>;
  let billingProfileRepository: ReturnType<typeof createMockRepository>;
  let checkoutOrderRepository: ReturnType<typeof createMockRepository>;
  let creditLotRepository: ReturnType<typeof createMockRepository>;
  let catalogPriceRepository: ReturnType<typeof createMockRepository>;
  let subscriptionBillingHistoryRepository: ReturnType<
    typeof createMockRepository
  >;
  let managerUpdate: jest.Mock;
  let verifier: { verify: jest.Mock };
  let rolloverExecute: jest.Mock;

  beforeEach(async () => {
    webhookEventRepository = createMockRepository();
    billingProfileRepository = createMockRepository();
    checkoutOrderRepository = createMockRepository();
    creditLotRepository = createMockRepository();
    catalogPriceRepository = createMockRepository();

    webhookEventRepository.findOne.mockResolvedValue(null);
    webhookEventRepository.save.mockImplementation(async (data) => ({
      id: 'webhook-row-1',
      ...data,
    }));

    billingProfileRepository.findOne.mockResolvedValue({
      id: 'profile-1',
      status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
    });

    catalogPriceRepository.findOne.mockResolvedValue({
      id: 'catalog-price-1',
      stripePriceId: 'price_pro_mensual',
      catalogItem: {
        isActive: true,
        plan: { planType: 'pro', isActive: true, documentsIncluded: 100 },
      },
    });

    creditLotRepository.findOne.mockResolvedValue(null);

    subscriptionBillingHistoryRepository = createMockRepository();
    subscriptionBillingHistoryRepository.findOne.mockResolvedValue(null);

    rolloverExecute = jest.fn().mockResolvedValue({ affected: 0 });
    managerUpdate = jest.fn();
    const manager = {
      /**
       * Por entidad, no un valor único: dentro de la transacción el caso de uso pide primero el
       * perfil (para bloquearlo) y después el plan (para saber cuántos documentos concede), y
       * devolverles lo mismo a los dos dejaría el lote sin `issued`.
       */
      findOne: jest.fn(async (entity: unknown) =>
        entity === PlanEntity
          ? { planType: 'pro', documentsIncluded: 100 }
          : {
              id: 'profile-1',
              stripeCustomerId: 'cus_1',
              stripeSubscriptionId: 'sub_1',
            },
      ),
      update: managerUpdate,
      getRepository: jest.fn((entity: unknown) =>
        entity === SubscriptionBillingHistoryEntity
          ? subscriptionBillingHistoryRepository
          : entity === CheckoutOrderEntity
            ? checkoutOrderRepository
            : creditLotRepository,
      ),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: rolloverExecute,
      }),
    };

    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) =>
        work(manager),
      ),
    };

    verifier = { verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Cadena real, sin dobles entre capas.
        ReceiveStripeWebhookUseCase,
        RegisterWebhookEventUseCase,
        StripeWebhookService,
        SubscriptionBillingService,
        RegisterSubscriptionBillingUseCase,
        BillingCatalogService,
        CheckoutOrderService,
        CatalogSyncService,
        { provide: StripeWebhookSignatureVerifierService, useValue: verifier },
        // El router solo lo usa para expandir el producto de un evento `price.*`, que este
        // flujo no ejercita; se provee para poder construir la cadena real.
        {
          provide: StripePaymentService,
          useValue: { retrieveProduct: jest.fn() },
        },
        {
          provide: getDataSourceToken(),
          useValue: dataSource as unknown as DataSource,
        },
        {
          provide: getRepositoryToken(WebhookEventEntity),
          useValue: webhookEventRepository,
        },
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        {
          provide: getRepositoryToken(CheckoutOrderEntity),
          useValue: checkoutOrderRepository,
        },
        {
          provide: getRepositoryToken(CreditLotEntity),
          useValue: creditLotRepository,
        },
        {
          provide: getRepositoryToken(SubscriptionBillingHistoryEntity),
          useValue: subscriptionBillingHistoryRepository,
        },
        {
          provide: getRepositoryToken(CatalogPriceEntity),
          useValue: catalogPriceRepository,
        },
        {
          provide: getRepositoryToken(PlanEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(CatalogItemEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(DocumentCreditPackEntity),
          useValue: createMockRepository(),
        },
      ],
    }).compile();

    receiveStripeWebhook = module.get(ReceiveStripeWebhookUseCase);
  });

  /**
   * `unknown` y no `Partial<Stripe.Event>`: `Stripe.Event` es una unión discriminada de decenas
   * de tipos de evento, y `Partial` de esa unión no acepta un literal parcial de ninguno.
   */
  const deliver = (event: unknown) => {
    verifier.verify.mockReturnValue(event as Stripe.Event);
    return receiveStripeWebhook.execute({
      rawBody: Buffer.from('{}'),
      signature: 't=1,v1=firma',
    });
  };

  const checkoutCompletedEvent = {
    id: 'evt_checkout',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        payment_intent: 'pi_1',
        metadata: {
          billingProfileId: 'profile-1',
          planType: 'pro',
          accountId: 'account-1',
        },
      },
    },
  };

  const invoicePaidEvent = {
    id: 'evt_invoice',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_1',
        customer: 'cus_1',
        currency: 'mxn',
        amount_paid: 149900,
        total: 149900,
        payment_intent: 'pi_1',
        status_transitions: { paid_at: PERIOD_START },
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              period: { start: PERIOD_START, end: PERIOD_END },
              pricing: { price_details: { price: 'price_pro_mensual' } },
            },
          ],
        },
      },
    },
  };

  describe('alta completa', () => {
    it('CA05 — checkout.session.completed vincula el perfil y cierra la orden, sin conceder documentos', async () => {
      const result = await deliver(checkoutCompletedEvent);

      expect(result).toEqual({ received: true, duplicate: false });
      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          currentPlanType: 'pro',
        }),
      );
      expect(checkoutOrderRepository.update).toHaveBeenCalledWith(
        {
          stripeCheckoutSessionId: 'cs_1',
          status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        },
        expect.objectContaining({
          status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
          stripePaymentIntentId: 'pi_1',
          stripeSubscriptionId: 'sub_1',
        }),
      );
      // Lo importante de este evento: NO concede saldo.
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });

    it('CA06 — invoice.paid emite el lote del periodo y deja la entrega PROCESSED', async () => {
      await deliver(invoicePaidEvent);

      expect(creditLotRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          billingProfileId: 'profile-1',
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
          issued: 100,
          remaining: 100,
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: 'sub_1',
        }),
      );
      expect(webhookEventRepository.update).toHaveBeenCalledWith(
        'webhook-row-1',
        expect.objectContaining({
          processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
        }),
      );
    });

    /**
     * El recorrido completo de esta historia: la entrega de Stripe acaba escribiendo un periodo
     * con su origen, su dinero y sus ids de rastreo. Es lo que sobrevive a la próxima renovación,
     * cuando el perfil ya diga otra cosa.
     */
    it('registra el periodo en el historial con origen STRIPE y el dinero cobrado', async () => {
      await deliver(invoicePaidEvent);

      expect(subscriptionBillingHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          billingProfileId: 'profile-1',
          source: BILLING_SOURCE_ENUM.STRIPE,
          planType: 'pro',
          amount: 149900,
          currency: 'mxn',
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: 'sub_1',
          stripeCustomerId: 'cus_1',
          stripePaymentIntentId: 'pi_1',
          externalReference: null,
          createdByUserId: null,
        }),
      );
    });

    it('deja el perfil con el plan y el periodo vigentes', async () => {
      await deliver(invoicePaidEvent);

      expect(managerUpdate).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-1',
        expect.objectContaining({
          currentPlanType: 'pro',
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          currentPeriodStart: new Date(PERIOD_START * 1000),
          currentPeriodEnd: new Date(PERIOD_END * 1000),
          stripeSubscriptionId: 'sub_1',
        }),
      );
    });

    /**
     * El otro extremo del criterio de aceptación: una factura que no se puede asociar a ningún
     * perfil deja un aviso con todos los ids y NO tumba el webhook. Un 5xx sólo conseguiría que
     * Stripe reintentara durante días algo que ningún reintento arregla.
     */
    it('una factura sin perfil asociado avisa pero no falla la entrega', async () => {
      billingProfileRepository.findOne.mockResolvedValue(null);

      const result = await deliver(invoicePaidEvent);

      expect(result).toEqual({ received: true, duplicate: false });
      expect(creditLotRepository.save).not.toHaveBeenCalled();
      expect(subscriptionBillingHistoryRepository.save).not.toHaveBeenCalled();
      expect(webhookEventRepository.update).toHaveBeenCalledWith(
        'webhook-row-1',
        expect.objectContaining({
          processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
        }),
      );
    });
  });

  /**
   * CA08: la guarda de `webhook_events` corta ANTES de tocar el dominio. Es la protección de
   * primer nivel; la de `credit_lots.stripe_invoice_id` (CA07) cubre el caso en que dos facturas
   * distintas describan el mismo cobro.
   */
  describe('CA08 — idempotencia de la entrega', () => {
    it('una re-entrega ya procesada responde bien y no repite ningún efecto', async () => {
      webhookEventRepository.findOne.mockResolvedValue({
        id: 'webhook-row-1',
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
      });

      const result = await deliver(invoicePaidEvent);

      expect(result).toEqual({ received: true, duplicate: true });
      expect(creditLotRepository.save).not.toHaveBeenCalled();
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    it('una entrega anterior que quedó FAILED sí se reprocesa', async () => {
      webhookEventRepository.findOne.mockResolvedValue({
        id: 'webhook-row-1',
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      });
      webhookEventRepository.findOneBy.mockResolvedValue({
        id: 'webhook-row-1',
      });

      const result = await deliver(invoicePaidEvent);

      expect(result).toEqual({ received: true, duplicate: false });
      expect(creditLotRepository.save).toHaveBeenCalled();
    });

    it('CA07 — una factura que ya emitió lote no emite otro aunque la entrega sea nueva', async () => {
      creditLotRepository.findOne.mockResolvedValue({ id: 'lot-existente' });

      await deliver({ ...invoicePaidEvent, id: 'evt_invoice_reintento' });

      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('reintentos', () => {
    it('un fallo de sincronización deja la entrega FAILED y propaga para que Stripe reintente', async () => {
      // El precio de la factura no está en el catálogo local: no hay forma de saber cuántos
      // documentos conceder, así que se falla ruidosamente en vez de conceder cero.
      catalogPriceRepository.findOne.mockResolvedValue(null);

      await expect(deliver(invoicePaidEvent)).rejects.toThrow();

      expect(webhookEventRepository.update).toHaveBeenCalledWith(
        'webhook-row-1',
        expect.objectContaining({
          processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
        }),
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('CA10 / CA11 — fallo de pago y cancelación', () => {
    it('invoice.payment_failed deja el perfil PAST_DUE sin emitir documentos', async () => {
      await deliver({
        id: 'evt_failed',
        type: 'invoice.payment_failed',
        data: { object: invoicePaidEvent.data.object },
      });

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        {
          status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
        },
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });

    it('customer.subscription.deleted cancela el perfil sin borrar su historial', async () => {
      await deliver({
        id: 'evt_deleted',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_1', customer: 'cus_1' } },
      });

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        {
          status: BILLING_PROFILE_STATUS_ENUM.CANCELED,
        },
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
      expect(creditLotRepository.update).not.toHaveBeenCalled();
    });
  });
});
