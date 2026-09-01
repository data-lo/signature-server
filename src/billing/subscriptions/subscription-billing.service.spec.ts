import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Stripe = require('stripe');
import { SubscriptionBillingService } from './subscription-billing.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import {
  BillingProfileNotFoundForInvoiceException,
  PlanNotFoundForInvoiceException,
} from '../exceptions/billing.exceptions';

const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z

const PLAN_PRICE = {
  id: 'plan-price-1',
  planCode: 'pro',
  stripePriceId: 'price_pro_mensual',
  plan: { code: 'pro', active: true, monthlyDocumentLimit: 100 },
};

function buildInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_1',
    customer: 'cus_1',
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
  let checkoutOrderService: { markCompleted: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    update: jest.Mock;
    getRepository: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let rolloverExecute: jest.Mock;

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
    checkoutOrderService = { markCompleted: jest.fn() };

    rolloverExecute = jest.fn().mockResolvedValue({ affected: 0 });
    manager = {
      findOne: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      update: jest.fn(),
      getRepository: jest.fn().mockReturnValue(creditLotRepository),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionBillingService,
        {
          provide: getDataSourceToken(),
          useValue: dataSource as unknown as DataSource,
        },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        { provide: BillingCatalogService, useValue: billingCatalogService },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
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
      metadata: { billingProfileId: 'profile-1', planCode: 'pro' },
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
          currentPlanCode: 'pro',
          status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
        }),
      );
      expect(checkoutOrderService.markCompleted).toHaveBeenCalledWith({
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
      });
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
  });

  describe('CA06 — invoice.paid activa el plan y emite el lote', () => {
    it('crea el lote CURRENT_PERIOD con el límite mensual del plan y activa el perfil', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(creditLotRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          billingProfileId: 'profile-1',
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
          issued: 100,
          remaining: 100,
          priority: 100,
          stripeInvoiceId: 'in_1',
          periodStart: new Date(PERIOD_START * 1000),
          periodEnd: new Date(PERIOD_END * 1000),
        }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-1',
        expect.objectContaining({
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          currentPlanCode: 'pro',
          stripeSubscriptionId: 'sub_1',
          currentPeriodStart: new Date(PERIOD_START * 1000),
          currentPeriodEnd: new Date(PERIOD_END * 1000),
        }),
      );
    });

    it('bloquea el perfil antes de tocar el saldo', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(manager.findOne).toHaveBeenCalledWith(BillingProfileEntity, {
        where: { id: 'profile-1' },
        lock: { mode: 'pessimistic_write' },
      });
    });
  });

  describe('CA07 — idempotencia de factura', () => {
    it('no emite un segundo lote si la factura ya generó uno', async () => {
      creditLotRepository.findOne.mockResolvedValue({ id: 'lot-existente' });

      await service.handleInvoicePaid(buildInvoice());

      expect(creditLotRepository.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    /**
     * La comprobación va DENTRO de la transacción y después del bloqueo: comprobar antes dejaría
     * una ventana en la que dos entregas simultáneas de la misma factura pasarían las dos.
     */
    it('comprueba la factura ya procesada después de bloquear, no antes', async () => {
      const orden: string[] = [];
      manager.findOne.mockImplementation(async () => {
        orden.push('lock');
        return { id: 'profile-1' };
      });
      creditLotRepository.findOne.mockImplementation(async () => {
        orden.push('check-invoice');
        return null;
      });

      await service.handleInvoicePaid(buildInvoice());

      expect(orden).toEqual(['lock', 'check-invoice']);
    });
  });

  describe('CA09 — renovación con rollover', () => {
    it('convierte el sobrante del periodo anterior en ROLLOVER y emite el lote nuevo', async () => {
      rolloverExecute.mockResolvedValue({ affected: 1 });

      await service.handleInvoicePaid(buildInvoice({ id: 'in_2' }));

      expect(rolloverExecute).toHaveBeenCalled();
      expect(creditLotRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
          stripeInvoiceId: 'in_2',
        }),
      );
    });

    it('el rollover sólo alcanza lotes CURRENT_PERIOD con saldo restante', async () => {
      const builder = manager.createQueryBuilder();

      await service.handleInvoicePaid(buildInvoice());

      expect(builder.set).toHaveBeenCalledWith({
        origin: CREDIT_LOT_ORIGIN_ENUM.ROLLOVER,
      });
      expect(builder.andWhere).toHaveBeenCalledWith('origin = :origin', {
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
      });
      expect(builder.andWhere).toHaveBeenCalledWith('remaining > 0');
    });
  });

  describe('CA12 — eventos fuera de orden', () => {
    it('encuentra el perfil por customer cuando la búsqueda por subscription falla', async () => {
      billingProfileRepository.findOne
        .mockResolvedValueOnce(null) // por stripeSubscriptionId
        .mockResolvedValueOnce({ id: 'profile-1' }); // por stripeCustomerId

      await service.handleInvoicePaid(buildInvoice());

      expect(billingProfileRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { stripeSubscriptionId: 'sub_1' },
      });
      expect(billingProfileRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { stripeCustomerId: 'cus_1' },
      });
      expect(creditLotRepository.save).toHaveBeenCalled();
    });

    it('backfillea el stripeSubscriptionId que faltaba en el perfil', async () => {
      billingProfileRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'profile-1', stripeSubscriptionId: null });

      await service.handleInvoicePaid(buildInvoice());

      expect(manager.update).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-1',
        expect.objectContaining({ stripeSubscriptionId: 'sub_1' }),
      );
    });
  });

  describe('fallos que deben provocar reintento de Stripe (5xx)', () => {
    it('lanza si no hay perfil por ninguno de los dos criterios', async () => {
      billingProfileRepository.findOne.mockResolvedValue(null);

      await expect(service.handleInvoicePaid(buildInvoice())).rejects.toThrow(
        BillingProfileNotFoundForInvoiceException,
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
    });

    it('lanza si el precio de la factura no está en el catálogo local', async () => {
      billingCatalogService.findPriceForInvoice.mockResolvedValue(null);

      await expect(service.handleInvoicePaid(buildInvoice())).rejects.toThrow(
        PlanNotFoundForInvoiceException,
      );
      expect(creditLotRepository.save).not.toHaveBeenCalled();
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
          currentPlanCode: 'pro',
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
