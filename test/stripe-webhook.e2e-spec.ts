import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import Stripe = require('stripe');

import { applyGlobalApiPrefix } from './../src/shared/constants/api-prefix.constants';
import { StripeWebhookController } from './../src/webhooks/stripe-webhook.controller';
import { ReceiveStripeWebhookUseCase } from './../src/webhooks/applications/receive-stripe-webhook.use-case';
import { RegisterWebhookEventUseCase } from './../src/webhooks/applications/register-webhook-event.use-case';
import { StripeWebhookSignatureVerifierService } from './../src/webhooks/stripe/stripe-webhook-signature-verifier.service';
import { WebhookEventEntity } from './../src/webhooks/entities/webhook-event.entity';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from './../src/webhooks/enums/webhook-processing-status.enum';
import { StripeWebhookService } from './../src/payments/stripe/stripe-webhook.service';
import { StripePaymentService } from './../src/payments/stripe/stripe-payment.service';
import { AccountSubscriptionEntity } from './../src/payments/entities/account-subscription.entity';
import { SubscriptionBillingService } from './../src/billing/subscriptions/subscription-billing.service';
import { BillingCatalogService } from './../src/billing/catalog/billing-catalog.service';
import { CatalogSyncService } from './../src/billing/catalog/catalog-sync.service';
import { CheckoutOrderService } from './../src/billing/checkout/checkout-order.service';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';
import { CheckoutOrderEntity } from './../src/billing/checkout/checkout-order.entity';
import { CreditLotEntity } from './../src/billing/credits/credit-lot.entity';
import { PlanEntity } from './../src/billing/catalog/plan.entity';
import { CatalogItemEntity } from './../src/billing/catalog/catalog-item.entity';
import { CatalogPriceEntity } from './../src/billing/catalog/catalog-price.entity';
import { DocumentCreditPackEntity } from './../src/billing/catalog/document-credit-pack.entity';
import { BILLING_PROFILE_STATUS_ENUM } from './../src/billing/enums/billing-profile-status.enum';
import { BILLING_INTERVAL_ENUM } from './../src/billing/enums/billing-interval.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from './../src/billing/enums/checkout-order-status.enum';
import { CHECKOUT_KIND_ENUM } from './../src/billing/enums/checkout-kind.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from './../src/billing/enums/credit-lot-origin.enum';
import { CATALOG_ITEM_TYPE_ENUM } from './../src/billing/enums/catalog-item-type.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from './../src/billing/enums/catalog-price-billing-mode.enum';
import { CATALOG_SOURCE_ENUM } from './../src/billing/enums/catalog-source.enum';
import { PLAN_CREATION_SOURCE_ENUM } from './../src/billing/enums/plan-creation-source.enum';
import {
  createDataSourceStub,
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

/**
 * Secreto de firma de esta prueba. NO es el del despliegue: la firma se genera acá mismo con el
 * SDK, así que el valor sólo tiene que coincidir consigo mismo. Que la verificación sea la real
 * —y no un doble— es justamente lo que se quiere probar.
 */
const WEBHOOK_SECRET = 'whsec_secreto_de_pruebas_e2e';
const STRIPE_ENDPOINT = '/api/v1/webhooks/stripe';

const PROFILE_ID = 'perfil-1';
const CUSTOMER_ID = 'cus_e2e';
const SUBSCRIPTION_ID = 'sub_e2e';
const PRICE_ID = 'price_e2e';
const PLAN_TYPE = 'pro';
const MONTHLY_DOCUMENT_LIMIT = 50;
const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z

const stripe = new Stripe('sk_test_llave_de_pruebas_e2e');

function invoicePaidEvent(overrides?: {
  eventId?: string;
  invoiceId?: string;
  priceId?: string;
}) {
  return {
    id: overrides?.eventId ?? 'evt_invoice_paid',
    type: 'invoice.paid',
    data: {
      object: {
        id: overrides?.invoiceId ?? 'in_e2e',
        customer: CUSTOMER_ID,
        parent: {
          subscription_details: { subscription: SUBSCRIPTION_ID },
        },
        lines: {
          data: [
            {
              period: { start: PERIOD_START, end: PERIOD_END },
              pricing: {
                price_details: { price: overrides?.priceId ?? PRICE_ID },
              },
            },
          ],
        },
      },
    },
  };
}

function checkoutCompletedEvent() {
  return {
    id: 'evt_checkout_completed',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_e2e',
        mode: 'subscription',
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
        payment_intent: 'pi_e2e',
        metadata: {
          billingProfileId: PROFILE_ID,
          planType: PLAN_TYPE,
          accountId: 'cuenta-1',
        },
      },
    },
  };
}

function productEvent(
  type: 'product.created' | 'product.updated' | 'product.deleted',
  product: Record<string, unknown>,
) {
  return { id: `evt_${type}`, type, data: { object: product } };
}

/**
 * Recorrido HTTP completo de una entrega de Stripe: firma real sobre el cuerpo CRUDO, prefijo
 * global, enrutado del evento y efecto de dominio.
 *
 * Complementa —no repite— a `subscription-webhook-flow.integration.spec.ts`, que entra por el
 * caso de uso con la firma ya sustituida por un doble. Lo que sólo se puede comprobar acá es el
 * tramo que aquél se salta: que `rawBody` llegue intacto al verificador (cualquier
 * reserialización del JSON rompe el HMAC y sería invisible en una prueba de integración), que la
 * ruta viva bajo `/api/v1`, y que cada desenlace produzca el código HTTP que hace que Stripe
 * reintente o no.
 */
describe('Webhook de Stripe (e2e)', () => {
  let app: INestApplication;
  let webhookEvents: InMemoryRepository<never>;
  let billingProfiles: InMemoryRepository<never>;
  let checkoutOrders: InMemoryRepository<never>;
  let creditLots: InMemoryRepository<never>;
  let plans: InMemoryRepository<never>;
  let catalogItems: InMemoryRepository<never>;

  /** Firma el cuerpo tal cual se va a enviar, que es como lo hace Stripe de verdad. */
  function sign(body: string): string {
    return stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
    });
  }

  /** `signature: ''` envía la entrega SIN la cabecera; omitirlo firma el cuerpo correctamente. */
  function post(event: unknown, signature?: string) {
    const body = JSON.stringify(event);
    const header = signature === undefined ? sign(body) : signature;

    const pending = request(app.getHttpServer())
      .post(STRIPE_ENDPOINT)
      .set('Content-Type', 'application/json');

    return header === ''
      ? pending.send(body)
      : pending.set('stripe-signature', header).send(body);
  }

  beforeEach(async () => {
    webhookEvents = createInMemoryRepository();
    billingProfiles = createInMemoryRepository([
      {
        id: PROFILE_ID,
        personalAccountId: 'cuenta-1',
        organizationId: null,
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: null,
        currentPlanType: null,
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      },
    ] as never[]);
    checkoutOrders = createInMemoryRepository([
      {
        id: 'orden-1',
        billingProfileId: PROFILE_ID,
        catalogPriceId: 'precio-1',
        kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
        stripeCheckoutSessionId: 'cs_e2e',
        stripePaymentIntentId: null,
        status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        completedAt: null,
      },
    ] as never[]);
    creditLots = createInMemoryRepository();
    catalogItems = createInMemoryRepository();
    plans = createInMemoryRepository([
      {
        planType: PLAN_TYPE,
        catalogItemId: null,
        name: 'Plan Pro',
        isActive: true,
        creationSource: PLAN_CREATION_SOURCE_ENUM.STRIPE,
        stripeProductId: null,
        documentsIncluded: MONTHLY_DOCUMENT_LIMIT,
      },
    ] as never[]);

    const catalogPrices = createInMemoryRepository([
      {
        id: 'precio-1',
        stripePriceId: PRICE_ID,
        amount: 49900,
        currency: 'mxn',
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
        isActive: true,
        effectiveFrom: null,
        effectiveTo: null,
        catalogItem: { isActive: true, plan: plans.rows[0], scopes: [] },
      },
    ] as never[]);

    const { dataSource } = createDataSourceStub(
      new Map<unknown, InMemoryRepository<never>>([
        [CreditLotEntity, creditLots],
        [BillingProfileEntity, billingProfiles],
      ]),
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        ReceiveStripeWebhookUseCase,
        RegisterWebhookEventUseCase,
        StripeWebhookSignatureVerifierService,
        StripeWebhookService,
        StripePaymentService,
        SubscriptionBillingService,
        BillingCatalogService,
        CatalogSyncService,
        CheckoutOrderService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                STRIPE_SECRET_KEY: 'sk_test_llave_de_pruebas_e2e',
                STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
              })[key],
          },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getRepositoryToken(WebhookEventEntity),
          useValue: webhookEvents,
        },
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: createInMemoryRepository(),
        },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfiles,
        },
        {
          provide: getRepositoryToken(CheckoutOrderEntity),
          useValue: checkoutOrders,
        },
        { provide: getRepositoryToken(CatalogPriceEntity), useValue: catalogPrices },
        { provide: getRepositoryToken(PlanEntity), useValue: plans },
        {
          provide: getRepositoryToken(CatalogItemEntity),
          useValue: catalogItems,
        },
        {
          provide: getRepositoryToken(DocumentCreditPackEntity),
          useValue: createInMemoryRepository(),
        },
      ],
    }).compile();

    /**
     * `rawBody: true` es la misma opción que pasa `main.ts` a `NestFactory.create`. Sin ella
     * `request.rawBody` llega `undefined` y el verificador rechaza TODA entrega — exactamente el
     * fallo de despliegue que esta prueba existe para detectar.
     */
    app = moduleFixture.createNestApplication({ rawBody: true });
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('autenticación de la entrega', () => {
    it('acepta una entrega firmada y la deja PROCESSED', async () => {
      const response = await post(invoicePaidEvent());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, duplicate: false });
      expect(webhookEvents.rows).toHaveLength(1);
      expect(webhookEvents.rows[0]).toMatchObject({
        providerEventId: 'evt_invoice_paid',
        eventType: 'invoice.paid',
        signatureValid: true,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
      });
    });

    it('rechaza con 401 una firma que no corresponde al cuerpo', async () => {
      const response = await post(
        invoicePaidEvent(),
        sign(JSON.stringify({ id: 'evt_otro', type: 'invoice.paid' })),
      );

      expect(response.status).toBe(401);
      expect(creditLots.rows).toHaveLength(0);
    });

    it('rechaza con 401 una entrega sin cabecera de firma', async () => {
      const response = await post(invoicePaidEvent(), '');

      expect(response.status).toBe(401);
      expect(creditLots.rows).toHaveLength(0);
    });

    /**
     * Un cuerpo alterado después de firmarse: es el caso que separa "verifico la firma" de
     * "verifico la firma CONTRA EL CUERPO CRUDO". Si en algún punto se reserializara el JSON
     * antes de verificar, esta manipulación pasaría desapercibida.
     */
    it('rechaza con 401 un cuerpo manipulado tras la firma', async () => {
      const original = JSON.stringify(invoicePaidEvent());
      const header = sign(original);
      const manipulado = original.replace('"in_e2e"', '"in_manipulada"');

      const response = await request(app.getHttpServer())
        .post(STRIPE_ENDPOINT)
        .set('Content-Type', 'application/json')
        .set('stripe-signature', header)
        .send(manipulado);

      expect(response.status).toBe(401);
      expect(creditLots.rows).toHaveLength(0);
    });

    it('deja rastro de la entrega rechazada', async () => {
      await post(invoicePaidEvent(), 't=1,v1=firma_invalida');

      expect(webhookEvents.rows).toHaveLength(1);
      expect(webhookEvents.rows[0]).toMatchObject({
        signatureValid: false,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      });
    });
  });

  describe('prefijo global', () => {
    it('no responde en la ruta sin el prefijo /api/v1', async () => {
      const body = JSON.stringify(invoicePaidEvent());

      const response = await request(app.getHttpServer())
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', sign(body))
        .send(body);

      expect(response.status).toBe(404);
    });
  });

  describe('alta de la suscripción', () => {
    it('checkout.session.completed vincula el perfil y cierra la orden, sin conceder documentos', async () => {
      const response = await post(checkoutCompletedEvent());

      expect(response.status).toBe(200);
      expect(billingProfiles.rows[0]).toMatchObject({
        stripeSubscriptionId: SUBSCRIPTION_ID,
        currentPlanType: PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      });
      expect(checkoutOrders.rows[0]).toMatchObject({
        status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        stripePaymentIntentId: 'pi_e2e',
      });
      expect(creditLots.rows).toHaveLength(0);
    });

    it('invoice.paid activa el perfil y emite el lote del periodo', async () => {
      const response = await post(invoicePaidEvent());

      expect(response.status).toBe(200);
      expect(billingProfiles.rows[0]).toMatchObject({
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: PLAN_TYPE,
      });
      expect(creditLots.rows).toHaveLength(1);
      expect(creditLots.rows[0]).toMatchObject({
        billingProfileId: PROFILE_ID,
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
        issued: MONTHLY_DOCUMENT_LIMIT,
        remaining: MONTHLY_DOCUMENT_LIMIT,
        stripeInvoiceId: 'in_e2e',
      });
    });
  });

  describe('idempotencia', () => {
    it('una re-entrega ya procesada responde 200 sin repetir el efecto', async () => {
      await post(invoicePaidEvent());
      const reentrega = await post(invoicePaidEvent());

      expect(reentrega.status).toBe(200);
      expect(reentrega.body).toEqual({ received: true, duplicate: true });
      expect(creditLots.rows).toHaveLength(1);
    });

    /**
     * Otro `evt_...`, misma factura: para la tabla de entregas es un evento nuevo, así que la
     * idempotencia por `stripe_invoice_id` dentro de la transacción es la única que lo detiene.
     */
    it('una entrega nueva de una factura ya cobrada no emite un segundo lote', async () => {
      await post(invoicePaidEvent());
      const otra = await post(invoicePaidEvent({ eventId: 'evt_reintento' }));

      expect(otra.status).toBe(200);
      expect(creditLots.rows).toHaveLength(1);
    });
  });

  describe('fallo de procesamiento', () => {
    /**
     * 5xx a propósito: es lo que hace que Stripe reintente durante días. Si esto respondiera
     * 200, un cobro real quedaría sin documentos y sin reintento.
     */
    it('una factura de un precio desconocido responde 5xx y deja la entrega FAILED', async () => {
      const response = await post(
        invoicePaidEvent({ priceId: 'price_que_no_existe' }),
      );

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(webhookEvents.rows[0]).toMatchObject({
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      });
      expect(creditLots.rows).toHaveLength(0);
    });
  });

  describe('sincronización de catálogo', () => {
    it('product.updated actualiza el plan local y lo vincula al producto de Stripe', async () => {
      const response = await post(
        productEvent('product.updated', {
          id: 'prod_e2e',
          name: 'Plan Pro (renombrado)',
          active: true,
          metadata: { catalogType: 'plan', planType: PLAN_TYPE },
        }),
      );

      expect(response.status).toBe(200);
      expect(plans.rows[0]).toMatchObject({
        name: 'Plan Pro (renombrado)',
        stripeProductId: 'prod_e2e',
        isActive: true,
      });
    });

    it('product.updated conserva documentsIncluded si Stripe no lo declara', async () => {
      await post(
        productEvent('product.updated', {
          id: 'prod_e2e',
          name: 'Plan Pro',
          active: true,
          metadata: { catalogType: 'plan', planType: PLAN_TYPE },
        }),
      );

      expect(plans.rows[0]).toMatchObject({
        documentsIncluded: MONTHLY_DOCUMENT_LIMIT,
      });
    });

    it('product.deleted desactiva el plan en vez de borrarlo', async () => {
      await catalogItems.save({
        id: 'catalog-item-e2e',
        itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
        source: CATALOG_SOURCE_ENUM.STRIPE,
        stripeProductId: 'prod_e2e',
        isActive: true,
      } as never);

      const response = await post(
        productEvent('product.deleted', {
          id: 'prod_e2e',
          name: 'Plan Pro',
          metadata: { catalogType: 'plan', planType: PLAN_TYPE },
        }),
      );

      expect(response.status).toBe(200);
      expect(plans.rows).toHaveLength(1);
      expect(catalogItems.rows[0]).toMatchObject({ isActive: false });
    });

    it('ignora un producto ajeno al catálogo sin fallar la entrega', async () => {
      const response = await post(
        productEvent('product.created', {
          id: 'prod_ajeno',
          name: 'Otro producto de la cuenta de Stripe',
          active: true,
          metadata: {},
        }),
      );

      expect(response.status).toBe(200);
      expect(plans.rows).toHaveLength(1);
      expect(plans.rows[0]).toMatchObject({ stripeProductId: null });
    });
  });
});
