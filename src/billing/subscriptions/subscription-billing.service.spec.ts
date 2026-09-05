import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import Stripe = require('stripe');
import { SubscriptionBillingService } from './subscription-billing.service';
import { RegisterSubscriptionBillingUseCase } from './register-subscription-billing.use-case';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { PlanNotFoundForInvoiceException } from '../exceptions/billing.exceptions';

const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z
const PAID_AT = 1893456300; // 2030-01-01T00:05:00Z

const PLAN_PRICE = {
  id: 'catalog-price-1',
  stripePriceId: 'price_pro_mensual',
  catalogItem: {
    isActive: true,
    plan: { planType: 'pro', isActive: true, documentsIncluded: 100 },
  },
};

function buildInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_1',
    customer: 'cus_1',
    currency: 'mxn',
    amount_paid: 149900,
    total: 149900,
    payment_intent: 'pi_1',
    status_transitions: { paid_at: PAID_AT },
    parent: { subscription_details: { subscription: 'sub_1' } },
    lines: {
      data: [
        {
          period: { start: PERIOD_START, end: PERIOD_END },
          pricing: { price_details: { price: 'price_pro_mensual' } },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

describe('SubscriptionBillingService', () => {
  let service: SubscriptionBillingService;
  let billingProfileRepository: { findOne: jest.Mock; update: jest.Mock };
  let creditLotRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let billingCatalogService: { findPriceForInvoice: jest.Mock };
  let checkoutOrderService: {
    markCompleted: jest.Mock;
    linkCompletedSubscriptionToCreditSlot: jest.Mock;
    linkCheckoutSessionToCreditSlot: jest.Mock;
  };
  let registerSubscriptionBilling: { execute: jest.Mock };

  beforeEach(async () => {
    billingProfileRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      update: jest.fn(),
    };
    creditLotRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'lot-1', ...data })),
    };
    billingCatalogService = {
      findPriceForInvoice: jest.fn().mockResolvedValue(PLAN_PRICE),
    };
    checkoutOrderService = {
      markCompleted: jest.fn(),
      linkCompletedSubscriptionToCreditSlot: jest.fn(),
      linkCheckoutSessionToCreditSlot: jest.fn(),
    };
    registerSubscriptionBilling = {
      execute: jest.fn().mockResolvedValue({
        history: { id: 'period-1' },
        alreadyRegistered: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionBillingService,
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        {
          provide: getRepositoryToken(CreditLotEntity),
          useValue: creditLotRepository,
        },
        { provide: BillingCatalogService, useValue: billingCatalogService },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
        {
          provide: RegisterSubscriptionBillingUseCase,
          useValue: registerSubscriptionBilling,
        },
      ],
    }).compile();

    service = module.get(SubscriptionBillingService);
  });

  describe('CA05 — checkout.session.completed', () => {
    const session = {
      id: 'cs_1',
      mode: 'subscription',
      customer: 'cus_1',
      subscription: 'sub_1',
      payment_intent: 'pi_1',
      metadata: { billingProfileId: 'profile-1', planType: 'pro' },
    } as unknown as Stripe.Checkout.Session;

    it('guarda customer, subscription y plan en el perfil, y cierra la orden', async () => {
      billingProfileRepository.findOne.mockResolvedValue({
        id: 'profile-1',
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      });

      await service.handleCheckoutSessionCompleted(session);

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          currentPlanType: 'pro',
          status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
        }),
      );
      expect(checkoutOrderService.markCompleted).toHaveBeenCalledWith({
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
        stripeSubscriptionId: 'sub_1',
      });
    });

    /**
     * El caso normal desde que toda cuenta nace con perfil: quien contrata viene del plan
     * gratuito, no de un INCOMPLETE previo. Si el perfil se quedara en FREE, entre el fin del
     * checkout y el cobro diría "plan gratuito" cuando el usuario ya contrató.
     */
    it('avanza a INCOMPLETE el perfil que venía en plan Free', async () => {
      billingProfileRepository.findOne.mockResolvedValue({
        id: 'profile-1',
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        currentPlanType: 'free',
      });

      await service.handleCheckoutSessionCompleted(session);

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
          currentPlanType: 'pro',
        }),
      );
    });

    /**
     * CA12 al revés: si `invoice.paid` ganó la carrera y ya dejó el perfil en ACTIVE, esta
     * entrega no puede devolverlo a INCOMPLETE — eso le quitaría el acceso a alguien que ya pagó.
     */
    it('no retrocede a INCOMPLETE un perfil que invoice.paid ya activó', async () => {
      billingProfileRepository.findOne.mockResolvedValue({
        id: 'profile-1',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      });

      await service.handleCheckoutSessionCompleted(session);

      const changes = billingProfileRepository.update.mock.calls[0][1];
      expect(changes).not.toHaveProperty('status');
    });

    it.each([
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('tampoco toca el estado de un perfil %s', async (status) => {
      billingProfileRepository.findOne.mockResolvedValue({
        id: 'profile-1',
        status,
      });

      await service.handleCheckoutSessionCompleted(session);

      const changes = billingProfileRepository.update.mock.calls[0][1];
      expect(changes).not.toHaveProperty('status');
    });

    it('ignora una sesión que no es del flujo de billing (sin billingProfileId)', async () => {
      await service.handleCheckoutSessionCompleted({
        ...session,
        metadata: {},
      } as unknown as Stripe.Checkout.Session);

      expect(billingProfileRepository.update).not.toHaveBeenCalled();
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
    });

    it('ignora una sesión que no es de suscripción', async () => {
      await service.handleCheckoutSessionCompleted({
        ...session,
        mode: 'payment',
      } as unknown as Stripe.Checkout.Session);

      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    it('enlaza la sesión al slot si invoice.paid llegó antes que Checkout', async () => {
      creditLotRepository.findOne.mockResolvedValue({ id: 'lot-1' });

      await service.handleCheckoutSessionCompleted(session);

      expect(
        checkoutOrderService.linkCheckoutSessionToCreditSlot,
      ).toHaveBeenCalledWith({
        stripeCheckoutSessionId: 'cs_1',
        creditSlotId: 'lot-1',
      });
    });
  });

  describe('invoice.paid — adaptación a `RegisterSubscriptionBillingUseCase`', () => {
    it('traduce la factura y delega el efecto económico', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith({
        billingProfileId: 'profile-1',
        source: BILLING_SOURCE_ENUM.STRIPE,
        planType: 'pro',
        amount: 149900,
        currency: 'mxn',
        periodStart: new Date(PERIOD_START * 1000),
        periodEnd: new Date(PERIOD_END * 1000),
        paidAt: new Date(PAID_AT * 1000),
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        stripeInvoiceId: 'in_1',
        stripePaymentIntentId: 'pi_1',
      });
    });

    /**
     * El adaptador ya no emite saldo ni escribe historial: eso vive en el caso de uso porque un
     * cobro manual tiene que producir exactamente lo mismo, y dos copias de esa lógica se separan
     * a la primera corrección.
     */
    it('no toca créditos ni perfil por su cuenta', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(creditLotRepository.save).not.toHaveBeenCalled();
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    /**
     * `amount_paid` y no `total`: difieren cuando la factura se liquida en parte con saldo del
     * cliente o con un cupón, y el historial tiene que cuadrar con el dinero que entró.
     */
    it('registra lo realmente cobrado, no lo facturado', async () => {
      await service.handleInvoicePaid(
        buildInvoice({ amount_paid: 50000, total: 149900 }),
      );

      expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000 }),
      );
    });

    /**
     * El periodo vive en la LÍNEA de la factura desde la API de 2025. Buscarlo en la suscripción
     * —donde lo pone toda la documentación anterior— devuelve `undefined` en silencio.
     */
    it('toma el periodo de la línea de la factura', async () => {
      await service.handleInvoicePaid(
        buildInvoice({
          lines: {
            data: [
              {
                period: { start: 1900000000, end: 1902678400 },
                pricing: { price_details: { price: 'price_pro_mensual' } },
              },
            ],
          },
        }),
      );

      expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          periodStart: new Date(1900000000 * 1000),
          periodEnd: new Date(1902678400 * 1000),
        }),
      );
    });

    it('cae a "ahora" si la factura no informa cuándo se pagó', async () => {
      const antes = Date.now();

      await service.handleInvoicePaid(buildInvoice({ status_transitions: {} }));

      const { paidAt } = registerSubscriptionBilling.execute.mock.calls[0][0];
      expect(paidAt.getTime()).toBeGreaterThanOrEqual(antes);
    });

    /**
     * Un cobro suelto —un paquete de documentos— no abre un periodo ni renueva un plan, y
     * registrarlo como tal dejaría el perfil diciendo que tiene una suscripción que nadie contrató.
     */
    it('ignora una factura que no es de suscripción', async () => {
      await service.handleInvoicePaid(buildInvoice({ parent: null }));

      expect(registerSubscriptionBilling.execute).not.toHaveBeenCalled();
    });
  });

  describe('eventos fuera de orden y facturas huérfanas', () => {
    /**
     * El `stripe_customer_id` se graba antes de abrir el checkout; el `stripe_subscription_id` no
     * existe hasta que la sesión se completa. Sin este respaldo, un `invoice.paid` que se
     * adelantara a `checkout.session.completed` quedaría huérfano.
     */
    it('encuentra el perfil por customer cuando la búsqueda por subscription falla', async () => {
      billingProfileRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'profile-1' });

      await service.handleInvoicePaid(buildInvoice());

      expect(billingProfileRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { stripeSubscriptionId: 'sub_1' },
      });
      expect(billingProfileRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { stripeCustomerId: 'cus_1' },
      });
      expect(registerSubscriptionBilling.execute).toHaveBeenCalled();
    });

    /**
     * **Se avisa y se responde 2xx en vez de fallar.** Un 5xx haría que Stripe reintentara durante
     * días y ninguno de esos reintentos encontraría el perfil: si no está vinculado ni por
     * suscripción ni por cliente, el vínculo no aparece solo. Lo arregla una persona, y para eso
     * el warning lleva todos los ids con los que buscar.
     */
    it('avisa con todos los ids y no falla si no hay perfil que asociar', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      billingProfileRepository.findOne.mockResolvedValue(null);

      await expect(
        service.handleInvoicePaid(buildInvoice()),
      ).resolves.toBeUndefined();

      expect(registerSubscriptionBilling.execute).not.toHaveBeenCalled();
      const mensaje = warn.mock.calls[0][0] as string;
      expect(mensaje).toContain('in_1');
      expect(mensaje).toContain('sub_1');
      expect(mensaje).toContain('cus_1');
    });

    /**
     * Ésta sí falla ruidosamente: hubo un cobro real y no sabemos cuántos documentos concede el
     * plan. A diferencia del perfil ausente, esto SÍ se arregla solo en cuanto el catálogo se
     * sincronice, así que los reintentos de Stripe trabajan a favor.
     */
    it('lanza si el precio de la factura no está en el catálogo local', async () => {
      billingCatalogService.findPriceForInvoice.mockResolvedValue(null);

      await expect(service.handleInvoicePaid(buildInvoice())).rejects.toThrow(
        PlanNotFoundForInvoiceException,
      );
      expect(registerSubscriptionBilling.execute).not.toHaveBeenCalled();
    });
  });

  describe('CA10 — invoice.payment_failed', () => {
    it('marca PAST_DUE sin emitir documentos', async () => {
      await service.handleInvoicePaymentFailed(buildInvoice());

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        { status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE },
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });

    it('no lanza si el cobro fallido no corresponde a ningún perfil local', async () => {
      billingProfileRepository.findOne.mockResolvedValue(null);

      await expect(
        service.handleInvoicePaymentFailed(buildInvoice()),
      ).resolves.toBeUndefined();
    });
  });

  describe('customer.subscription.updated', () => {
    const subscription = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      items: {
        data: [
          {
            price: { id: 'price_pro_mensual' },
            current_period_start: PERIOD_START,
            current_period_end: PERIOD_END,
          },
        ],
      },
    } as unknown as Stripe.Subscription;

    it('sincroniza estado, plan, id de suscripción y periodo', async () => {
      await service.handleSubscriptionUpdated(subscription);

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          stripeSubscriptionId: 'sub_1',
          currentPlanType: 'pro',
          currentPeriodStart: new Date(PERIOD_START * 1000),
          currentPeriodEnd: new Date(PERIOD_END * 1000),
        }),
      );
    });

    it.each([
      ['past_due', BILLING_PROFILE_STATUS_ENUM.PAST_DUE],
      ['unpaid', BILLING_PROFILE_STATUS_ENUM.PAST_DUE],
      ['canceled', BILLING_PROFILE_STATUS_ENUM.CANCELED],
      ['incomplete_expired', BILLING_PROFILE_STATUS_ENUM.CANCELED],
      ['trialing', BILLING_PROFILE_STATUS_ENUM.ACTIVE],
      ['paused', BILLING_PROFILE_STATUS_ENUM.INCOMPLETE],
    ])(
      'traduce el estado %s de Stripe a %s',
      async (stripeStatus, expected) => {
        await service.handleSubscriptionUpdated({
          ...subscription,
          status: stripeStatus,
        } as unknown as Stripe.Subscription);

        expect(billingProfileRepository.update).toHaveBeenCalledWith(
          'profile-1',
          expect.objectContaining({ status: expected }),
        );
      },
    );
  });

  describe('CA11 — customer.subscription.deleted', () => {
    it('cancela el perfil sin tocar lotes ni consumos', async () => {
      await service.handleSubscriptionDeleted({
        id: 'sub_1',
        customer: 'cus_1',
      } as unknown as Stripe.Subscription);

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        { status: BILLING_PROFILE_STATUS_ENUM.CANCELED },
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });
  });
});
