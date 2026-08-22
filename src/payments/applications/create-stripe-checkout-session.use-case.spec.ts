import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { StripePaymentGatewayService } from '../stripe/stripe-payment-gateway.service';
import { CreateStripeCheckoutSessionUseCase } from './create-stripe-checkout-session.use-case';

const USER_ID = 'user-1';
const EMAIL = 'juan@empresa.com';
const ACCOUNT_ID = 'account-1';
const PRICE_ID = 'price_mensual';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_123';

const SERVICIO_MENSUAL = {
  priceId: PRICE_ID,
  productId: 'prod_1',
  name: 'Plan Pro',
  description: 'Firma ilimitada',
  unitAmount: 49900,
  currency: 'mxn',
  interval: 'month',
  intervalCount: 1,
  imageUrl: null,
};

const SERVICIO_PAGO_UNICO = {
  ...SERVICIO_MENSUAL,
  priceId: 'price_unico',
  interval: null,
  intervalCount: null,
};

describe('CreateStripeCheckoutSessionUseCase', () => {
  let useCase: CreateStripeCheckoutSessionUseCase;
  let subscriptionRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let accountRepository: { findOne: jest.Mock };
  let paymentGateway: {
    listActiveServices: jest.Mock;
    createCheckoutSession: jest.Mock;
    createCustomer: jest.Mock;
  };

  beforeEach(async () => {
    process.env.FRONTEND_URL = 'https://app.firmalo.test';

    subscriptionRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'sub-1', stripeCustomerId: 'cus_existente' }),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'sub-1', ...data })),
      update: jest.fn(),
    };
    accountRepository = {
      findOne: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
    };
    paymentGateway = {
      listActiveServices: jest.fn().mockResolvedValue([SERVICIO_MENSUAL]),
      createCheckoutSession: jest.fn().mockResolvedValue(CHECKOUT_URL),
      createCustomer: jest.fn().mockResolvedValue('cus_nuevo'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateStripeCheckoutSessionUseCase,
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: subscriptionRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: StripePaymentGatewayService,
          useValue: paymentGateway,
        },
      ],
    }).compile();

    useCase = module.get(CreateStripeCheckoutSessionUseCase);
  });

  it('devuelve la URL de Checkout y nada más', async () => {
    const result = await useCase.execute(USER_ID, EMAIL, PRICE_ID);

    expect(result).toEqual({ checkoutUrl: CHECKOUT_URL });
  });

  describe('validación del servicio', () => {
    it('rechaza un precio que no está en el catálogo activo, sin crear sesión', async () => {
      await expect(
        useCase.execute(USER_ID, EMAIL, 'price_archivado'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(paymentGateway.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('el catálogo es la fuente de verdad: no basta con que el precio tenga forma válida', async () => {
      paymentGateway.listActiveServices.mockResolvedValue([]);

      await expect(
        useCase.execute(USER_ID, EMAIL, PRICE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('modo de cobro', () => {
    it('usa subscription cuando el precio es recurrente', async () => {
      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'subscription' }),
      );
    });

    it('usa payment cuando el precio es de pago único', async () => {
      paymentGateway.listActiveServices.mockResolvedValue([
        SERVICIO_PAGO_UNICO,
      ]);

      await useCase.execute(USER_ID, EMAIL, SERVICIO_PAGO_UNICO.priceId);

      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'payment' }),
      );
    });
  });

  describe('URLs de retorno', () => {
    it('devuelve al usuario a suscripciones, con el resultado del pago en la URL', async () => {
      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      const [input] = paymentGateway.createCheckoutSession.mock.calls[0];
      expect(input.successUrl).toBe(
        'https://app.firmalo.test/dashboard/subscriptions?payment=success&session_id={CHECKOUT_SESSION_ID}',
      );
      expect(input.cancelUrl).toBe(
        'https://app.firmalo.test/dashboard/subscriptions?payment=cancel',
      );
    });

    it('normaliza la diagonal final de FRONTEND_URL', async () => {
      process.env.FRONTEND_URL = 'https://app.firmalo.test/';

      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      const [input] = paymentGateway.createCheckoutSession.mock.calls[0];
      expect(input.successUrl).not.toContain('.test//dashboard');
    });
  });

  describe('cliente de Stripe', () => {
    it('reutiliza el cliente existente de la cuenta', async () => {
      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      expect(paymentGateway.createCustomer).not.toHaveBeenCalled();
      expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_existente' }),
      );
    });

    it('crea uno la primera vez y lo guarda para los siguientes cobros', async () => {
      subscriptionRepository.findOne.mockResolvedValue({
        id: 'sub-1',
        stripeCustomerId: null,
      });

      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      expect(paymentGateway.createCustomer).toHaveBeenCalledWith(
        ACCOUNT_ID,
        EMAIL,
      );
      expect(subscriptionRepository.update).toHaveBeenCalledWith('sub-1', {
        stripeCustomerId: 'cus_nuevo',
      });
    });

    it('crea la fila de suscripción si la cuenta nunca intentó pagar', async () => {
      subscriptionRepository.findOne.mockResolvedValue(null);

      await useCase.execute(USER_ID, EMAIL, PRICE_ID);

      expect(subscriptionRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID }),
      );
    });
  });

  it('manda el accountId en la metadata: sin él el webhook no puede reconciliar el pago', async () => {
    await useCase.execute(USER_ID, EMAIL, PRICE_ID);

    expect(paymentGateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { accountId: ACCOUNT_ID, priceId: PRICE_ID },
      }),
    );
  });

  it('lanza 404 si el usuario no pertenece a una cuenta activa', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute(USER_ID, EMAIL, PRICE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
