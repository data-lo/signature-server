import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadGatewayException } from '@nestjs/common';
import { StripePaymentGatewayService } from './stripe-payment-gateway.service';

const mockPricesList = jest.fn();
const mockSessionsCreate = jest.fn();
const mockCustomersCreate = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPricesList },
    checkout: { sessions: { create: mockSessionsCreate } },
    customers: { create: mockCustomersCreate },
  })),
);

/** Un precio activo con su producto expandido, como lo devuelve `prices.list`. */
function precio(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price_mensual',
    currency: 'mxn',
    unit_amount: 49900,
    recurring: { interval: 'month', interval_count: 1 },
    product: {
      id: 'prod_1',
      name: 'Plan Pro',
      description: 'Firma ilimitada',
      active: true,
      images: ['https://files.stripe.com/plan-pro.png'],
    },
    ...overrides,
  };
}

describe('StripePaymentGatewayService', () => {
  let service: StripePaymentGatewayService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPricesList.mockResolvedValue({ data: [precio()] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripePaymentGatewayService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('sk_test_123') },
        },
      ],
    }).compile();

    service = module.get(StripePaymentGatewayService);
  });

  describe('catálogo', () => {
    it('normaliza precio y producto en un servicio del dominio', async () => {
      await expect(service.listActiveServices()).resolves.toEqual([
        {
          priceId: 'price_mensual',
          productId: 'prod_1',
          name: 'Plan Pro',
          description: 'Firma ilimitada',
          unitAmount: 49900,
          currency: 'mxn',
          interval: 'month',
          intervalCount: 1,
          imageUrl: 'https://files.stripe.com/plan-pro.png',
        },
      ]);
    });

    it('pide sólo precios activos y expande el producto en la misma llamada', async () => {
      await service.listActiveServices();

      expect(mockPricesList).toHaveBeenCalledWith(
        expect.objectContaining({ active: true, expand: ['data.product'] }),
      );
    });

    it('un pago único queda sin periodicidad', async () => {
      mockPricesList.mockResolvedValue({
        data: [precio({ recurring: null })],
      });

      const [servicio] = await service.listActiveServices();

      expect(servicio.interval).toBeNull();
      expect(servicio.intervalCount).toBeNull();
    });

    describe('descarta lo que no es vendible', () => {
      it.each([
        ['el producto está inactivo', { ...precio().product, active: false }],
        ['el producto está borrado', { id: 'prod_1', deleted: true }],
      ])('%s', async (_caso, product) => {
        mockPricesList.mockResolvedValue({ data: [precio({ product })] });

        await expect(service.listActiveServices()).resolves.toEqual([]);
      });

      it('el producto no vino expandido', async () => {
        mockPricesList.mockResolvedValue({
          data: [precio({ product: 'prod_1' })],
        });

        await expect(service.listActiveServices()).resolves.toEqual([]);
      });
    });

    it('traduce un fallo del proveedor a 502, sin filtrar su error', async () => {
      mockPricesList.mockRejectedValue(
        new Error('Stripe: no such api key sk_test_123'),
      );

      await expect(service.listActiveServices()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  describe('sesión de Checkout', () => {
    const input = {
      priceId: 'price_mensual',
      mode: 'subscription' as const,
      customerId: 'cus_1',
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
      metadata: { accountId: 'account-1' },
    };

    it('devuelve la URL hospedada', async () => {
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_1',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      });

      await expect(service.createCheckoutSession(input)).resolves.toBe(
        'https://checkout.stripe.com/c/pay/cs_1',
      );
    });

    it('copia la metadata a la suscripción: los eventos de renovación no traen la de la sesión', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x' });

      await service.createCheckoutSession(input);

      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: { metadata: input.metadata },
        }),
      );
    });

    it('no manda subscription_data en un pago único', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x' });

      await service.createCheckoutSession({ ...input, mode: 'payment' });

      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({ subscription_data: expect.anything() }),
      );
    });

    it('trata una sesión sin URL como fallo del proveedor', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: null });

      await expect(service.createCheckoutSession(input)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });
});
