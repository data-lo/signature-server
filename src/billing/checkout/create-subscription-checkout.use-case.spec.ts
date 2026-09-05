import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { CreateSubscriptionCheckoutUseCase } from './create-subscription-checkout.use-case';
import { CheckoutOrderService } from './checkout-order.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  ActiveSubscriptionAlreadyExistsException,
  SubscriptionPriceNotAvailableException,
} from '../exceptions/billing.exceptions';

const PLAN_PRICE = {
  id: 'catalog-price-1',
  stripePriceId: 'price_pro_mensual',
  amount: 49900,
  currency: 'mxn',
  interval: BILLING_INTERVAL_ENUM.MONTH,
  catalogItem: {
    isActive: true,
    plan: { planType: 'pro', isActive: true, documentsIncluded: 100 },
  },
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
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
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
          planType: 'pro',
          catalogPriceId: 'catalog-price-1',
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
      catalogPriceId: 'catalog-price-1',
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

  describe('suscripción ya activa', () => {
    const perfilConEstado = (status: BILLING_PROFILE_STATUS_ENUM) =>
      billingOwnerService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        stripeCustomerId: 'cus_1',
        status,
      });

    it('responde 409 y no toca ni a Stripe ni a CheckoutOrderService si el perfil está ACTIVE', async () => {
      perfilConEstado(BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      const fallo = await execute().catch((error: unknown) => error);

      expect(fallo).toBeInstanceOf(ActiveSubscriptionAlreadyExistsException);
      expect(
        (fallo as ActiveSubscriptionAlreadyExistsException).getStatus(),
      ).toBe(409);
      expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
      expect(paymentGateway.createCustomer).not.toHaveBeenCalled();
      expect(
        checkoutOrderService.registerPendingSubscription,
      ).not.toHaveBeenCalled();
    });

    /**
     * El corte va antes de la consulta al catálogo: abrir la sesión es lo caro y lo peligroso,
     * y consultar el precio de algo que no se va a vender sólo añade una consulta inútil.
     */
    it('corta antes de consultar el catálogo', async () => {
      perfilConEstado(BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      await expect(execute()).rejects.toThrow(
        ActiveSubscriptionAlreadyExistsException,
      );
      expect(
        billingCatalogService.findSellableRecurringPrice,
      ).not.toHaveBeenCalled();
    });

    /**
     * El perfil de una organización es uno solo y compartido: el propio `resolveOwner` ya
     * traduce la membresía a `organization_id`, así que la guarda se aplica igual cuando quien
     * pide el checkout es el segundo miembro de una organización que ya contrató.
     */
    it('bloquea igual cuando el propietario es una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue({
        personalAccountId: null,
        organizationId: 'org-1',
      });
      perfilConEstado(BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      await expect(execute()).rejects.toThrow(
        ActiveSubscriptionAlreadyExistsException,
      );
      expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
      expect(
        checkoutOrderService.registerPendingSubscription,
      ).not.toHaveBeenCalled();
    });

    it.each([
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('deja contratar si el perfil está %s', async (status) => {
      perfilConEstado(status);

      await expect(execute()).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      });
      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(
        checkoutOrderService.registerPendingSubscription,
      ).toHaveBeenCalledTimes(1);
    });
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
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
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
