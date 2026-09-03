import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { CreateSubscriptionCheckoutUseCase } from './create-subscription-checkout.use-case';
import { CheckoutOrderService } from './checkout-order.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { SubscriptionPriceNotAvailableException } from '../exceptions/billing.exceptions';

const PLAN_PRICE = {
  id: 'plan-price-1',
  planCode: 'pro',
  stripePriceId: 'price_pro_mensual',
  amount: 49900,
  currency: 'mxn',
  interval: BILLING_INTERVAL_ENUM.MONTH,
  plan: { code: 'pro', active: true, monthlyDocumentLimit: 100 },
};

describe('CreateSubscriptionCheckoutUseCase', () => {
  let useCase: CreateSubscriptionCheckoutUseCase;
  let billingProfileRepository: { update: jest.Mock };
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    getOrCreateProfile: jest.Mock;
  };
  let billingCatalogService: { findSellableRecurringPrice: jest.Mock };
  let checkoutOrderService: { registerPendingSubscription: jest.Mock };
  let paymentGateway: {
    createCheckoutSession: jest.Mock;
    createCustomer: jest.Mock;
  };

  beforeEach(async () => {
    billingProfileRepository = { update: jest.fn() };
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue({
        personalAccountId: 'account-1',
        organizationId: null,
      }),
      getOrCreateProfile: jest.fn().mockResolvedValue({
        id: 'profile-1',
        stripeCustomerId: 'cus_1',
      }),
    };
    billingCatalogService = {
      findSellableRecurringPrice: jest.fn().mockResolvedValue(PLAN_PRICE),
    };
    checkoutOrderService = {
      registerPendingSubscription: jest
        .fn()
        .mockResolvedValue({ id: 'order-1' }),
    };
    paymentGateway = {
      createCheckoutSession: jest.fn().mockResolvedValue({
        sessionId: 'cs_1',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      }),
      createCustomer: jest.fn().mockResolvedValue('cus_nuevo'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateSubscriptionCheckoutUseCase,
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        { provide: BillingOwnerService, useValue: billingOwnerService },
        { provide: BillingCatalogService, useValue: billingCatalogService },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
        { provide: StripePaymentService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(CreateSubscriptionCheckoutUseCase);
  });

  const execute = () =>
    useCase.execute({
      userId: 'user-1',
      email: 'usuario@correo.com',
      accountId: 'account-1',
      priceId: 'price_pro_mensual',
    });

  it('abre la sesión en modo subscription con la metadata que necesitan los webhooks', async () => {
    await execute();

    expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: 'price_pro_mensual',
        mode: 'subscription',
        customerId: 'cus_1',
        metadata: {
          billingProfileId: 'profile-1',
          planCode: 'pro',
          planPriceId: 'plan-price-1',
          accountId: 'account-1',
        },
      }),
    );
  });

  /**
   * CA04: la orden se registra DESPUÉS de que Stripe devuelve la sesión, porque su
   * `stripe_checkout_session_id` es la llave con la que el webhook la vuelve a encontrar.
   */
  it('CA04 — registra la orden PENDING con el id de sesión, el importe y la moneda del catálogo local', async () => {
    await execute();

    expect(
      checkoutOrderService.registerPendingSubscription,
    ).toHaveBeenCalledWith({
      billingProfileId: 'profile-1',
      planPriceId: 'plan-price-1',
      stripeCheckoutSessionId: 'cs_1',
      amount: 49900,
      currency: 'mxn',
    });
  });

  it('devuelve la URL de Checkout', async () => {
    await expect(execute()).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
    });
  });

  it('no abre ninguna sesión ni registra orden si el precio no es vendible', async () => {
    billingCatalogService.findSellableRecurringPrice.mockRejectedValue(
      new SubscriptionPriceNotAvailableException(),
    );

    await expect(execute()).rejects.toThrow(
      SubscriptionPriceNotAvailableException,
    );
    expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
    expect(
      checkoutOrderService.registerPendingSubscription,
    ).not.toHaveBeenCalled();
  });

  describe('cliente de Stripe', () => {
    it('reutiliza el cliente ya asociado al perfil', async () => {
      await execute();

      expect(paymentGateway.createCustomer).not.toHaveBeenCalled();
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    it('crea el cliente la primera vez y lo guarda en el perfil', async () => {
      billingOwnerService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        stripeCustomerId: null,
      });

      await execute();

      expect(paymentGateway.createCustomer).toHaveBeenCalledWith(
        'profile-1',
        'usuario@correo.com',
      );
      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        {
          stripeCustomerId: 'cus_nuevo',
        },
      );
      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_nuevo' }),
      );
    });
  });
});
