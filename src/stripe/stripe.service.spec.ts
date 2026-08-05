import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { SUBSCRIPTION_STATUS_ENUM } from './enums/subscription-status.enum';
import { PLAN_ID_ENUM } from './enums/plan-id.enum';

const mockSessionsCreate = jest.fn();
const mockCustomersCreate = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    customers: { create: mockCustomersCreate },
  })),
);

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn((data) => ({ id: 'subscription-1', ...data })),
    update: jest.fn(),
  };
}

const CONFIG_VALUES: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_PRICE_ID_BASIC: 'price_basic',
  STRIPE_PRICE_ID_PRO: 'price_pro',
  STRIPE_PRICE_ID_ENTERPRISE: 'price_enterprise',
  FRONTEND_URL: 'https://app.example.com',
};

describe('StripeService', () => {
  let service: StripeService;
  let subscriptionRepository: ReturnType<typeof createMockRepository>;
  let accountRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    jest.clearAllMocks();
    subscriptionRepository = createMockRepository();
    accountRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => CONFIG_VALUES[key] },
        },
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: subscriptionRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
  });

  describe('createCheckoutSession', () => {
    it('lanza NotFoundException si el plan no existe', async () => {
      await expect(
        service.createCheckoutSession(
          'account-1',
          'user@example.com',
          'unknown-plan' as PLAN_ID_ENUM,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    it('crea el customer si la cuenta aún no tiene uno y construye la sesión con las URLs correctas del dashboard', async () => {
      subscriptionRepository.findOne.mockResolvedValue(null);
      mockCustomersCreate.mockResolvedValue({ id: 'cus_new' });
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/cs_test_123',
      });

      const result = await service.createCheckoutSession(
        'account-1',
        'user@example.com',
        PLAN_ID_ENUM.PRO,
      );

      expect(mockCustomersCreate).toHaveBeenCalledWith({
        email: 'user@example.com',
        metadata: { accountId: 'account-1' },
      });
      expect(subscriptionRepository.update).toHaveBeenCalledWith(
        'subscription-1',
        { stripeCustomerId: 'cus_new' },
      );

      const [payload, options] = mockSessionsCreate.mock.calls[0];
      expect(payload).toMatchObject({
        mode: 'subscription',
        customer: 'cus_new',
        line_items: [{ price: 'price_pro', quantity: 1 }],
        success_url:
          'https://app.example.com/dashboard/plans/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.example.com/dashboard/plans/cancel',
      });
      expect(options.idempotencyKey).toContain('account-1');
      expect(options.idempotencyKey).toContain(PLAN_ID_ENUM.PRO);

      expect(result).toEqual({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/cs_test_123',
      });
    });

    it('reutiliza el customer existente sin crear uno nuevo', async () => {
      subscriptionRepository.findOne.mockResolvedValue({
        id: 'subscription-1',
        stripeCustomerId: 'cus_existing',
      });
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_test_456',
        url: 'https://checkout.stripe.com/cs_test_456',
      });

      await service.createCheckoutSession(
        'account-1',
        'user@example.com',
        PLAN_ID_ENUM.BASIC,
      );

      expect(mockCustomersCreate).not.toHaveBeenCalled();
      expect(subscriptionRepository.update).not.toHaveBeenCalled();
      const [payload] = mockSessionsCreate.mock.calls[0];
      expect(payload.customer).toBe('cus_existing');
    });

    it('usa la misma idempotency key para reintentos del mismo plan el mismo día, evitando sesiones duplicadas', async () => {
      subscriptionRepository.findOne.mockResolvedValue({
        id: 'subscription-1',
        stripeCustomerId: 'cus_existing',
      });
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_test_789',
        url: 'https://checkout.stripe.com/cs_test_789',
      });

      await service.createCheckoutSession(
        'account-1',
        'user@example.com',
        PLAN_ID_ENUM.BASIC,
      );
      await service.createCheckoutSession(
        'account-1',
        'user@example.com',
        PLAN_ID_ENUM.BASIC,
      );

      const [, firstOptions] = mockSessionsCreate.mock.calls[0];
      const [, secondOptions] = mockSessionsCreate.mock.calls[1];
      expect(firstOptions.idempotencyKey).toBe(secondOptions.idempotencyKey);
    });
  });

  describe('resolveAccountId', () => {
    it('lanza NotFoundException si el usuario no tiene una cuenta activa', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(service.resolveAccountId('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('devuelve el id de la membresía activa', async () => {
      accountRepository.findOne.mockResolvedValue({ id: 'account-1' });

      await expect(service.resolveAccountId('user-1')).resolves.toBe(
        'account-1',
      );
    });
  });
});
