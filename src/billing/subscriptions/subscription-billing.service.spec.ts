import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Stripe = require('stripe');
import { SubscriptionBillingService } from './subscription-billing.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { BILLING_PERIOD_END_REASON_ENUM } from '../enums/billing-period-end-reason.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import {
  BillingProfileNotFoundForInvoiceException,
  PlanNotFoundForInvoiceException,
} from '../exceptions/billing.exceptions';

const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z

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
  let historyRepository: { create: jest.Mock; save: jest.Mock };
  let billingCatalogService: { findPriceForInvoice: jest.Mock };
  let checkoutOrderService: {
    markCompleted: jest.Mock;
    linkCompletedSubscriptionToCreditSlot: jest.Mock;
    linkCheckoutSessionToCreditSlot: jest.Mock;
  };
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
    historyRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'period-1', ...data })),
    };
    billingCatalogService = {
      findPriceForInvoice: jest.fn().mockResolvedValue(PLAN_PRICE),
    };
    checkoutOrderService = {
      markCompleted: jest.fn(),
      linkCompletedSubscriptionToCreditSlot: jest.fn(),
      linkCheckoutSessionToCreditSlot: jest.fn(),
    };

    rolloverExecute = jest.fn().mockResolvedValue({ affected: 0 });
    manager = {
      findOne: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      update: jest.fn(),
      /**
       * Se enruta por entidad y no se devuelve siempre el mismo doble: el servicio pide desde la
       * misma transacción el repositorio de lotes y el del historial, y confundirlos haría que
       * una aserción sobre el saldo se cumpliera con una escritura del historial (o al revés).
       */
      getRepository: jest.fn((entity: unknown) =>
        entity === SubscriptionBillingHistoryEntity
          ? historyRepository
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
        {
          provide: getRepositoryToken(CreditLotEntity),
          useValue: creditLotRepository,
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
          stripeSubscriptionId: 'sub_1',
          periodStart: new Date(PERIOD_START * 1000),
          periodEnd: new Date(PERIOD_END * 1000),
        }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-1',
        expect.objectContaining({
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          currentPlanType: 'pro',
          stripeSubscriptionId: 'sub_1',
          currentPeriodStart: new Date(PERIOD_START * 1000),
          currentPeriodEnd: new Date(PERIOD_END * 1000),
        }),
      );
      expect(
        checkoutOrderService.linkCompletedSubscriptionToCreditSlot,
      ).toHaveBeenCalledWith({
        billingProfileId: 'profile-1',
        stripeSubscriptionId: 'sub_1',
        creditSlotId: 'lot-1',
      });
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
  describe('origen de facturación e historial de periodos', () => {
    it('un cobro de Stripe deja el perfil gobernado por STRIPE', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(manager.update).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-1',
        expect.objectContaining({
          billingSource: BILLING_SOURCE_ENUM.STRIPE,
        }),
      );
    });

    it('abre el periodo del historial con el origen y el plan cobrados', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(historyRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          billingProfileId: 'profile-1',
          planType: 'pro',
          source: BILLING_SOURCE_ENUM.STRIPE,
          status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
          periodStart: new Date(PERIOD_START * 1000),
          periodEnd: new Date(PERIOD_END * 1000),
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: 'sub_1',
          endedAt: null,
          endedReason: null,
        }),
      );
    });

    /**
     * `RENEWED` y no `MANUAL_PERIOD_ENDED`: el periodo anterior no se agotó, lo sustituyó uno
     * nuevo y el cliente no se quedó sin servicio ni un minuto. Esa diferencia es lo que hace
     * legible el historial meses después.
     */
    it('cierra el periodo anterior como RENEWED', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(manager.update).toHaveBeenCalledWith(
        SubscriptionBillingHistoryEntity,
        {
          billingProfileId: 'profile-1',
          status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
        },
        expect.objectContaining({
          status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
          endedReason: BILLING_PERIOD_END_REASON_ENUM.RENEWED,
        }),
      );
    });

    /**
     * El orden lo impone `UQ_subscription_billing_history_active`, que sólo tolera un periodo
     * vigente por perfil: abrir antes de cerrar reventaría contra el índice.
     */
    it('cierra el anterior antes de abrir el nuevo', async () => {
      const orden: string[] = [];
      manager.update.mockImplementation(async (entity: unknown) => {
        if (entity === SubscriptionBillingHistoryEntity) {
          orden.push('cierra');
        }
        return { affected: 1 };
      });
      historyRepository.save.mockImplementation(async (data) => {
        orden.push('abre');
        return { id: 'period-1', ...data };
      });

      await service.handleInvoicePaid(buildInvoice());

      expect(orden).toEqual(['cierra', 'abre']);
    });

    it('no escribe historial si la factura ya se había procesado', async () => {
      creditLotRepository.findOne.mockResolvedValue({ id: 'lot-existente' });

      await service.handleInvoicePaid(buildInvoice());

      expect(historyRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('perfiles de facturación manual frente a los webhooks de Stripe', () => {
    const manual = {
      id: 'profile-manual',
      billingSource: BILLING_SOURCE_ENUM.MANUAL,
      status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      currentPlanType: 'plus',
    };

    beforeEach(() => {
      billingProfileRepository.findOne.mockResolvedValue(manual);
      manager.findOne.mockResolvedValue(manual);
    });

    it('invoice.payment_failed no lo toca', async () => {
      await service.handleInvoicePaymentFailed({
        id: 'in_1',
        customer: 'cus_1',
      } as unknown as Stripe.Invoice);

      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    it('customer.subscription.updated no lo toca', async () => {
      await service.handleSubscriptionUpdated({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        items: { data: [{ price: 'price_pro_mensual' }] },
      } as unknown as Stripe.Subscription);

      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    /**
     * El caso que más daño haría: un perfil que estuvo en Stripe y luego pasó a facturación
     * manual conserva sus ids, así que una cancelación tardía de la suscripción vieja lo
     * encuentra. Dejarla pasar cancelaría a un cliente que está al corriente por otra vía.
     */
    it('customer.subscription.deleted no lo cancela', async () => {
      await service.handleSubscriptionDeleted({
        id: 'sub_1',
        customer: 'cus_1',
      } as unknown as Stripe.Subscription);

      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    /**
     * El checkout sí puede vincularlo con Stripe —sin eso el cobro posterior no encontraría el
     * perfil—, pero no puede quitarle el plan que tiene pagado antes de que ese cobro exista.
     */
    it('checkout.session.completed lo vincula pero no le cambia plan ni estado', async () => {
      await service.handleCheckoutSessionCompleted({
        id: 'cs_1',
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        payment_intent: 'pi_1',
        metadata: { billingProfileId: 'profile-manual', planType: 'pro' },
      } as unknown as Stripe.Checkout.Session);

      const cambios = billingProfileRepository.update.mock.calls[0][1];
      expect(cambios).toEqual({
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
      });
    });

    /**
     * El único camino permitido de manual a Stripe, y por eso está acá: hay un cobro confirmado
     * que justifica el cambio de gobierno. A partir de ahora lo mueven los webhooks y el cron
     * deja de verlo.
     */
    it('invoice.paid sí lo migra a STRIPE', async () => {
      await service.handleInvoicePaid(buildInvoice());

      expect(manager.update).toHaveBeenCalledWith(
        BillingProfileEntity,
        'profile-manual',
        expect.objectContaining({
          billingSource: BILLING_SOURCE_ENUM.STRIPE,
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        }),
      );
    });
  });
});
