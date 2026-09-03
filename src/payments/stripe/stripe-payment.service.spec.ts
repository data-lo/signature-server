import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  InternalServerErrorException,
} from '@nestjs/common';
import { StripePaymentService } from './stripe-payment.service';

const mockPricesList = jest.fn();
const mockProductsRetrieve = jest.fn();
const mockSessionsCreate = jest.fn();
const mockCustomersCreate = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPricesList },
    products: { retrieve: mockProductsRetrieve },
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
      metadata: { catalogType: 'plan', visibility: 'true', planType: 'pro' },
    },
    ...overrides,
  };
}

describe('StripePaymentService', () => {
  let service: StripePaymentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPricesList.mockResolvedValue({ data: [precio()] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripePaymentService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('sk_test_123') },
        },
      ],
    }).compile();

    service = module.get(StripePaymentService);
  });

  describe('catálogo público de planes', () => {
    it('normaliza precio y producto en un servicio del dominio', async () => {
      await expect(service.listPublicPlans()).resolves.toEqual([
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
      await service.listPublicPlans();

      expect(mockPricesList).toHaveBeenCalledWith(
        expect.objectContaining({ active: true, expand: ['data.product'] }),
      );
    });

    it('un pago único queda sin periodicidad', async () => {
      mockPricesList.mockResolvedValue({
        data: [precio({ recurring: null })],
      });

      const [servicio] = await service.listPublicPlans();

      expect(servicio.interval).toBeNull();
      expect(servicio.intervalCount).toBeNull();
    });

    /**
     * El filtro por metadata se aplica sobre la respuesta ya recibida porque `prices.list()` no
     * acepta condiciones sobre la metadata del producto: es una limitación de Stripe, y por eso
     * se prueba en su adaptador y no en el caso de uso.
     */
    describe('descarta lo que no es un plan público', () => {
      it.each([
        ['el producto está inactivo', { ...precio().product, active: false }],
        ['el producto está borrado', { id: 'prod_1', deleted: true }],
        [
          'el producto no es del catálogo de planes',
          {
            ...precio().product,
            metadata: { catalogType: 'document_pack', visibility: 'true' },
          },
        ],
        [
          'el producto está oculto',
          {
            ...precio().product,
            metadata: { catalogType: 'plan', visibility: 'false' },
          },
        ],
        [
          'el producto no declara visibilidad',
          { ...precio().product, metadata: { catalogType: 'plan' } },
        ],
        ['el producto no trae metadata', { ...precio().product, metadata: {} }],
      ])('%s', async (_caso, product) => {
        mockPricesList.mockResolvedValue({ data: [precio({ product })] });

        await expect(service.listPublicPlans()).resolves.toEqual([]);
      });

      it('el producto no vino expandido', async () => {
        mockPricesList.mockResolvedValue({
          data: [precio({ product: 'prod_1' })],
        });

        await expect(service.listPublicPlans()).resolves.toEqual([]);
      });
    });

    /** La metadata la teclea una persona en el dashboard de Stripe, no otro sistema. */
    it('tolera espacios y mayúsculas en la metadata', async () => {
      mockPricesList.mockResolvedValue({
        data: [
          precio({
            product: {
              ...precio().product,
              metadata: { catalogType: ' Plan ', visibility: ' TRUE ' },
            },
          }),
        ],
      });

      await expect(service.listPublicPlans()).resolves.toHaveLength(1);
    });

    it('deja fuera al plan gratuito, que no se administra en Stripe', async () => {
      mockPricesList.mockResolvedValue({ data: [] });

      await expect(service.listPublicPlans()).resolves.toEqual([]);
    });

    it('traduce un fallo del proveedor a 502, sin filtrar su error', async () => {
      mockPricesList.mockRejectedValue(
        new Error('Stripe: no such api key sk_test_123'),
      );

      await expect(service.listPublicPlans()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  /**
   * Lo usa la sincronización de catálogo: un evento `price.*` trae `product` como id suelto y la
   * metadata que decide a qué tabla local pertenece el precio vive en el producto.
   */
  describe('producto por id', () => {
    it('devuelve el producto que responde Stripe', async () => {
      const producto = { id: 'prod_pro', name: 'Plan Pro' };
      mockProductsRetrieve.mockResolvedValue(producto);

      await expect(service.retrieveProduct('prod_pro')).resolves.toBe(producto);
      expect(mockProductsRetrieve).toHaveBeenCalledWith('prod_pro');
    });

    it('traduce un fallo del proveedor a 502, sin filtrar su error', async () => {
      mockProductsRetrieve.mockRejectedValue(new Error('Stripe: timeout'));

      await expect(service.retrieveProduct('prod_pro')).rejects.toBeInstanceOf(
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

    /**
     * El `sessionId` viaja junto a la URL —antes se devolvía sólo la URL— porque es la llave con
     * la que `checkout_orders` se reconcilia después: `checkout.session.completed` sólo trae el
     * id de la sesión, así que sin guardarlo al crearla no habría forma de encontrar la orden
     * pendiente que le corresponde.
     */
    it('devuelve el id de la sesión y su URL hospedada', async () => {
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_1',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      });

      await expect(service.createCheckoutSession(input)).resolves.toEqual({
        sessionId: 'cs_1',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      });
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

  /**
   * La distinción que faltaba: unas credenciales rechazadas son un problema de configuración
   * NUESTRO, no una caída del proveedor. Mientras las dos cosas salían como 502, una llave
   * equivocada en el despliegue se presentaba como "Stripe no está disponible" y mandaba a
   * buscar el fallo donde no estaba.
   */
  describe('clasificación de errores de Stripe', () => {
    function stripeError(fields: Record<string, unknown>) {
      return Object.assign(new Error('Invalid API Key provided'), fields);
    }

    it.each([
      [
        'StripeAuthenticationError por tipo',
        { type: 'StripeAuthenticationError' },
      ],
      ['StripePermissionError por tipo', { type: 'StripePermissionError' }],
      ['un 401 sin tipo', { statusCode: 401 }],
      ['un 403 sin tipo', { statusCode: 403 }],
    ])(
      'reporta %s como configuración nuestra, no como proveedor caído',
      async (_caso, fields) => {
        mockPricesList.mockRejectedValue(stripeError(fields));

        await expect(service.listPublicPlans()).rejects.toBeInstanceOf(
          InternalServerErrorException,
        );
        await expect(service.listPublicPlans()).rejects.not.toBeInstanceOf(
          BadGatewayException,
        );
      },
    );

    it('mantiene el 502 para un fallo que sí es del proveedor', async () => {
      mockPricesList.mockRejectedValue(
        stripeError({ type: 'StripeConnectionError', statusCode: 503 }),
      );

      await expect(service.listPublicPlans()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('aplica la misma clasificación al abrir el Checkout', async () => {
      mockSessionsCreate.mockRejectedValue(
        stripeError({ type: 'StripeAuthenticationError' }),
      );

      await expect(
        service.createCheckoutSession({
          priceId: 'price_mensual',
          mode: 'payment',
          customerId: 'cus_1',
          successUrl: 'https://app.test/ok',
          cancelUrl: 'https://app.test/cancel',
          metadata: {},
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('aplica la misma clasificación al crear el cliente', async () => {
      mockCustomersCreate.mockRejectedValue(stripeError({ statusCode: 401 }));

      await expect(
        service.createCustomer('account-1', 'quien@paga.com'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  /**
   * Sin llave el SDK ya fallaba, pero con "Neither apiKey nor config.authenticator provided":
   * un mensaje que no nombra la variable y que, por ocurrir al construir el proveedor, tumba el
   * arranque de toda la aplicación. Quien lea ese log tiene que saber qué le falta al entorno.
   */
  it('sin STRIPE_SECRET_KEY falla nombrando la variable que falta', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          StripePaymentService,
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue(undefined) },
          },
        ],
      }).compile(),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
