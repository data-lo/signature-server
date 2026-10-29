import { Test, TestingModule } from '@nestjs/testing';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { CreateDocumentCreditCheckoutUseCase } from './create-document-credit-checkout.use-case';
import { CheckoutOrderService } from './checkout-order.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { StripeCustomerService } from '../profiles/stripe-customer.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  DocumentCreditOfferNotAvailableException,
  InvalidDocumentCreditQuantityException,
} from '../exceptions/billing.exceptions';
import { MAX_DOCUMENT_CREDITS_PER_PURCHASE } from '../credits/document-credit-quantity';

const PERSONAL_OWNER = {
  personalAccountId: 'account-1',
  organizationId: null,
};

function precioDeCreditos(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-price-1',
    catalogItemId: 'catalog-item-1',
    stripePriceId: 'price_extra_doc',
    amount: 3900,
    currency: 'mxn',
    catalogItem: {
      id: 'catalog-item-1',
      name: 'Documento adicional',
      documentCreditPack: { documentsGranted: 1 },
    },
    ...overrides,
  };
}

describe('CreateDocumentCreditCheckoutUseCase', () => {
  let useCase: CreateDocumentCreditCheckoutUseCase;
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    getOrCreateProfile: jest.Mock;
  };
  let stripeCustomerService: { resolveForProfile: jest.Mock };
  let billingCatalogService: { findSellableDocumentCreditPrice: jest.Mock };
  let checkoutOrderService: { registerPendingDocumentCredits: jest.Mock };
  let paymentGateway: { createCheckoutSession: jest.Mock };

  const perfil = (overrides: Record<string, unknown> = {}) => ({
    id: 'perfil-1',
    status: BILLING_PROFILE_STATUS_ENUM.FREE,
    currentPlanType: 'free',
    stripeCustomerId: 'cus_123',
    ...overrides,
  });

  beforeEach(async () => {
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(PERSONAL_OWNER),
      getOrCreateProfile: jest.fn().mockResolvedValue(perfil()),
    };
    stripeCustomerService = {
      resolveForProfile: jest.fn().mockResolvedValue('cus_123'),
    };
    billingCatalogService = {
      findSellableDocumentCreditPrice: jest
        .fn()
        .mockResolvedValue(precioDeCreditos()),
    };
    checkoutOrderService = {
      registerPendingDocumentCredits: jest
        .fn()
        .mockResolvedValue({ id: 'orden-1' }),
    };
    paymentGateway = {
      createCheckoutSession: jest.fn().mockResolvedValue({
        sessionId: 'cs_test_123',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateDocumentCreditCheckoutUseCase,
        { provide: BillingOwnerService, useValue: billingOwnerService },
        { provide: StripeCustomerService, useValue: stripeCustomerService },
        { provide: BillingCatalogService, useValue: billingCatalogService },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
        { provide: StripePaymentService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(CreateDocumentCreditCheckoutUseCase);
  });

  const comprar = (catalogPriceId = 'catalog-price-1', quantity = 1) =>
    useCase.execute({
      userId: 'user-1',
      email: 'juan@mail.com',
      accountId: 'account-1',
      catalogPriceId,
      quantity,
    });

  describe('compra correcta', () => {
    it('devuelve la URL de Checkout', async () => {
      await expect(comprar()).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
    });

    /**
     * Modo `payment` y no `subscription`: comprar documentos es un cobro único que no crea ni
     * modifica ninguna suscripción.
     */
    it('abre la sesión en modo payment con el precio del catálogo', async () => {
      await comprar();

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'payment',
          priceId: 'price_extra_doc',
          customerId: 'cus_123',
        }),
      );
    });

    /** Es lo que permite reconciliar el pago sin volver a preguntarle nada a Stripe. */
    it('manda la metadata que necesita el webhook para acreditar', async () => {
      await comprar();

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            billingProfileId: 'perfil-1',
            catalogPriceId: 'catalog-price-1',
            catalogItemId: 'catalog-item-1',
            quantity: '1',
            accountId: 'account-1',
          },
        }),
      );
    });

    /**
     * La orden se escribe ANTES de mandar al usuario a Stripe: si se registrara al volver, un
     * pago cuyo navegador nunca regresó quedaría cobrado y sin rastro local que reconciliar.
     */
    it('registra la orden PENDING con el importe y la moneda del catálogo local', async () => {
      await comprar();

      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).toHaveBeenCalledWith({
        billingProfileId: 'perfil-1',
        catalogPriceId: 'catalog-price-1',
        stripeCheckoutSessionId: 'cs_test_123',
        quantity: 1,
        amount: 3900,
        currency: 'mxn',
      });
    });

    it('vuelve al dashboard con un retorno propio, distinto al de la suscripción', async () => {
      await comprar();

      const { successUrl, cancelUrl } =
        paymentGateway.createCheckoutSession.mock.calls[0][0];
      expect(successUrl).toContain('purchase=credits');
      expect(successUrl).toContain('session_id={CHECKOUT_SESSION_ID}');
      expect(cancelUrl).toContain('purchase=cancel');
      // El de la suscripción sigue siendo suyo: compartirlo diría "suscripción activa".
      expect(successUrl).not.toContain('payment=success');
    });
  });

  describe('el plan decide qué se puede comprar', () => {
    /** La validación se hace contra el plan del PERFIL, nunca contra nada de la petición. */
    it('valida el precio contra el plan vigente de la cuenta', async () => {
      billingOwnerService.getOrCreateProfile.mockResolvedValue(
        perfil({ currentPlanType: 'premium' }),
      );

      await comprar();

      expect(
        billingCatalogService.findSellableDocumentCreditPrice,
      ).toHaveBeenCalledWith('catalog-price-1', 'premium', PERSONAL_OWNER);
    });

    /**
     * El criterio explícito: no se puede comprar un paquete incompatible manipulando el
     * `catalogPriceId`. Quien rechaza es el catálogo, y acá se comprueba que el rechazo corta
     * antes de tocar a Stripe o registrar cualquier orden.
     */
    it('no abre sesión ni registra orden si el paquete no le corresponde', async () => {
      billingCatalogService.findSellableDocumentCreditPrice.mockRejectedValue(
        new DocumentCreditOfferNotAvailableException(),
      );

      await expect(comprar('catalog-price-de-premium')).rejects.toThrow(
        DocumentCreditOfferNotAvailableException,
      );
      expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).not.toHaveBeenCalled();
    });

    it('rechaza si la cuenta no tiene plan vigente, sin consultar el catálogo', async () => {
      billingOwnerService.getOrCreateProfile.mockResolvedValue(
        perfil({ currentPlanType: null }),
      );

      await expect(comprar()).rejects.toThrow(
        DocumentCreditOfferNotAvailableException,
      );
      expect(
        billingCatalogService.findSellableDocumentCreditPrice,
      ).not.toHaveBeenCalled();
    });

    /**
     * Sin `stripe_price_id` no hay nada que cobrarle a Stripe. Es una oferta que
     * `GetAvailableDocumentCreditOffersUseCase` ni siquiera lista.
     */
    it('rechaza un paquete que no está publicado en Stripe', async () => {
      billingCatalogService.findSellableDocumentCreditPrice.mockResolvedValue(
        precioDeCreditos({ stripePriceId: null }),
      );

      await expect(comprar()).rejects.toThrow(
        DocumentCreditOfferNotAvailableException,
      );
      expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  /**
   * La diferencia deliberada con el checkout de suscripción, que sí responde 409 sobre un perfil
   * ACTIVE: los paquetes de documentos siguen disponibles con plan vigente — comprar de más es
   * justamente lo que hace quien ya tiene plan.
   */
  describe('convive con una suscripción activa', () => {
    it('deja comprar con el perfil ACTIVE', async () => {
      billingOwnerService.getOrCreateProfile.mockResolvedValue(
        perfil({
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          currentPlanType: 'premium',
        }),
      );

      await expect(comprar()).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
    });

    it('deja comprar con la baja ya programada', async () => {
      billingOwnerService.getOrCreateProfile.mockResolvedValue(
        perfil({
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
          currentPlanType: 'premium',
          cancelAtPeriodEnd: true,
        }),
      );

      await expect(comprar()).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
    });
  });

  /** Un perfil tiene UN cliente en Stripe, compartido con el flujo de suscripción. */
  it('reutiliza el cliente de Stripe del perfil', async () => {
    await comprar();

    expect(stripeCustomerService.resolveForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'perfil-1' }),
      'juan@mail.com',
    );
  });

  describe('cantidad de documentos', () => {
    it('una sola unidad cobra el precio unitario y la manda bloqueada a Stripe', async () => {
      await comprar('catalog-price-1', 1);

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: 'price_extra_doc', quantity: 1 }),
      );
      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 1, amount: 3900 }),
      );
    });

    /** Un solo Price sirve para cualquier cantidad: no se pide un precio distinto por cantidad. */
    it('varias unidades multiplican el precio del catálogo con el mismo Price', async () => {
      await comprar('catalog-price-1', 5);

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          priceId: 'price_extra_doc',
          quantity: 5,
          metadata: expect.objectContaining({ quantity: '5' }),
        }),
      );
      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).toHaveBeenCalledWith({
        billingProfileId: 'perfil-1',
        catalogPriceId: 'catalog-price-1',
        stripeCheckoutSessionId: 'cs_test_123',
        quantity: 5,
        amount: 19500,
        currency: 'mxn',
      });
    });

    it('acepta el máximo permitido', async () => {
      await expect(
        comprar('catalog-price-1', MAX_DOCUMENT_CREDITS_PER_PURCHASE),
      ).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100, amount: 390000 }),
      );
    });

    /** El importe sale SIEMPRE del catálogo; la cantidad sólo lo multiplica. */
    it('calcula el importe con el precio unitario vigente del catálogo', async () => {
      billingCatalogService.findSellableDocumentCreditPrice.mockResolvedValue(
        precioDeCreditos({ amount: 2500 }),
      );

      await comprar('catalog-price-1', 3);

      expect(
        checkoutOrderService.registerPendingDocumentCredits,
      ).toHaveBeenCalledWith(expect.objectContaining({ amount: 7500 }));
    });

    /**
     * Una cantidad inválida se rechaza antes de todo: ni se resuelve el perfil, ni se consulta el
     * catálogo, ni se abre sesión en Stripe, ni se registra orden.
     */
    it.each([
      ['cero', 0],
      ['negativa', -1],
      ['decimal', 2.5],
      ['superior al máximo', MAX_DOCUMENT_CREDITS_PER_PURCHASE + 1],
    ])(
      'rechaza una cantidad %s sin tocar la base ni Stripe',
      async (_caso, quantity) => {
        await expect(comprar('catalog-price-1', quantity)).rejects.toThrow(
          InvalidDocumentCreditQuantityException,
        );
        expect(billingOwnerService.resolveOwner).not.toHaveBeenCalled();
        expect(
          billingCatalogService.findSellableDocumentCreditPrice,
        ).not.toHaveBeenCalled();
        expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
        expect(
          checkoutOrderService.registerPendingDocumentCredits,
        ).not.toHaveBeenCalled();
      },
    );
  });
});
