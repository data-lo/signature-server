import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadGatewayException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import type { CheckoutSessionLineItem } from 'src/payments/interfaces/checkout-session-line-item.interface';
import { RegisterDocumentCreditPurchaseUseCase } from './register-document-credit-purchase.use-case';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

/**
 * Construye una sesión de Stripe ya completada para las pruebas; por defecto es una compra de
 * documentos, y cada prueba sobrescribe lo que necesita.
 *
 * @param overrides - Campos que reemplazan a los del objeto por defecto.
 * @returns La sesión lista para pasarla al caso de uso.
 *
 * @example
 * const s = sesion({ mode: 'subscription' });
 */
function sesion(
  overrides: Record<string, unknown> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_123',
    mode: 'payment',
    payment_intent: 'pi_123',
    metadata: {
      billingProfileId: 'perfil-1',
      catalogPriceId: 'catalog-price-1',
      quantity: '1',
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

/**
 * La orden ADD_ON que se registró antes de mandar al usuario a Stripe. Por defecto, UNA unidad del
 * paquete de 5 documentos a $299.
 *
 * @param overrides - Campos que reemplazan a los de la orden por defecto.
 * @returns La orden, con su `catalogPrice` cargado como lo trae el caso de uso.
 *
 * @example
 * const o = orden({ creditSlotId: 'lote-1' });
 */
function orden(overrides: Record<string, unknown> = {}) {
  return {
    id: 'orden-1',
    creditSlotId: null,
    kind: CHECKOUT_KIND_ENUM.ADD_ON,
    quantity: 1,
    amount: 29900,
    currency: 'mxn',
    catalogPrice: {
      catalogItemId: 'catalog-item-1',
      stripePriceId: 'price_pack_5',
      catalogItem: { documentCreditPack: { documentsGranted: 5 } },
    },
    ...overrides,
  };
}

/**
 * Una línea cobrada según Stripe; por defecto, la que cuadra con la orden por defecto.
 *
 * @param overrides - Campos que reemplazan a los de la línea por defecto.
 * @returns La línea tal como la devuelve `listCheckoutSessionLineItems`.
 *
 * @example
 * const l = linea({ quantity: 4 });
 */
function linea(
  overrides: Partial<CheckoutSessionLineItem> = {},
): CheckoutSessionLineItem {
  return {
    stripePriceId: 'price_pack_5',
    quantity: 1,
    amountSubtotal: 29900,
    currency: 'mxn',
    ...overrides,
  };
}

describe('RegisterDocumentCreditPurchaseUseCase', () => {
  let useCase: RegisterDocumentCreditPurchaseUseCase;
  let checkoutOrderService: {
    markCompleted: jest.Mock;
    linkCheckoutSessionToCreditSlot: jest.Mock;
  };
  let paymentGateway: { listCheckoutSessionLineItems: jest.Mock };
  let ordenEncontrada: ReturnType<typeof orden> | null;
  /** Lo que Stripe dice que se cobró en la sesión. */
  let lineas: CheckoutSessionLineItem[];
  /** Lotes "en la base", para poder afirmar cuántos se emitieron en total. */
  let lotes: Record<string, unknown>[];
  let lotePorPaymentIntent: Record<string, unknown> | null;

  /**
   * Deja preparada la compra del criterio de aceptación: 5 unidades del documento suelto
   * (`documentsGranted=1`, $39 c/u), pagadas tal cual se validaron.
   *
   * @returns Nada; ajusta la orden y las líneas de la prueba en curso.
   *
   * @example
   * compraDeCincoDocumentosSueltos();
   */
  function compraDeCincoDocumentosSueltos(): void {
    ordenEncontrada = orden({
      quantity: 5,
      amount: 19500,
      catalogPrice: {
        catalogItemId: 'catalog-item-1',
        stripePriceId: 'price_extra_doc',
        catalogItem: { documentCreditPack: { documentsGranted: 1 } },
      },
    });
    lineas = [
      linea({
        stripePriceId: 'price_extra_doc',
        quantity: 5,
        amountSubtotal: 19500,
      }),
    ];
  }

  beforeEach(async () => {
    ordenEncontrada = orden();
    lineas = [linea()];
    lotes = [];
    lotePorPaymentIntent = null;

    checkoutOrderService = {
      markCompleted: jest.fn().mockResolvedValue(undefined),
      linkCheckoutSessionToCreditSlot: jest.fn().mockResolvedValue(undefined),
    };

    paymentGateway = {
      listCheckoutSessionLineItems: jest.fn(async () => lineas),
    };

    const creditLotRepository = {
      findOne: jest.fn(async () => lotePorPaymentIntent),
      create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
      save: jest.fn(async (data: Record<string, unknown>) => {
        const guardado = { id: `lote-${lotes.length + 1}`, ...data };
        lotes.push(guardado);
        return guardado;
      }),
    };

    const manager = {
      getRepository: jest.fn(() => creditLotRepository),
    };

    const dataSource = {
      getRepository: jest.fn(() => ({
        findOne: jest.fn(async () => ordenEncontrada),
      })),
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) =>
        work(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterDocumentCreditPurchaseUseCase,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
        { provide: StripePaymentService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(RegisterDocumentCreditPurchaseUseCase);
  });

  describe('pago exitoso', () => {
    it('acredita un lote ADD_ON con los documentos que concede el paquete', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(1);
      expect(lotes[0]).toMatchObject({
        billingProfileId: 'perfil-1',
        origin: CREDIT_LOT_ORIGIN_ENUM.ADD_ON,
        issued: 5,
        remaining: 5,
        stripePaymentIntentId: 'pi_123',
      });
    });

    /** El criterio de aceptación, literal. */
    it('un pago de 5 unidades acredita exactamente 5 documentos cuando documentsGranted=1', async () => {
      compraDeCincoDocumentosSueltos();

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(1);
      expect(lotes[0]).toMatchObject({ issued: 5, remaining: 5 });
    });

    it('multiplica los documentos del paquete por la cantidad pagada', async () => {
      ordenEncontrada = orden({
        quantity: 3,
        amount: 89700,
        catalogPrice: {
          catalogItemId: 'catalog-item-10',
          stripePriceId: 'price_pack_10',
          catalogItem: { documentCreditPack: { documentsGranted: 10 } },
        },
      });
      lineas = [
        linea({
          stripePriceId: 'price_pack_10',
          quantity: 3,
          amountSubtotal: 89700,
        }),
      ];

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes[0]).toMatchObject({ issued: 30, remaining: 30 });
    });

    /** La cantidad que se acredita es la que Stripe cobró: hay que preguntársela. */
    it('lee de Stripe las líneas cobradas de esa sesión', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(paymentGateway.listCheckoutSessionLineItems).toHaveBeenCalledWith(
        'cs_test_123',
      );
    });

    /**
     * Lo comprado suelto no pertenece a ningún periodo facturado: atarlo al vigente haría que un
     * paquete comprado el día 28 se evaporara dos días después.
     */
    it('el lote comprado no caduca ni queda atado a un periodo', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes[0]).toMatchObject({
        expiresAt: null,
        periodStart: null,
        periodEnd: null,
        stripeSubscriptionId: null,
      });
    });

    /**
     * Prioridad cero: con el desempate por antigüedad de `ConsumeDocumentCreditUseCase`, se gasta
     * primero el lote de bienvenida —siempre más viejo— y sólo después lo pagado. Los del periodo
     * facturado (100) siguen yendo por delante de los dos porque caducan.
     */
    it('se gasta después de los documentos del periodo facturado', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes[0].priority).toBe(0);
    });

    it('cierra la orden y la vincula al lote acreditado', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(checkoutOrderService.markCompleted).toHaveBeenCalledWith(
        {
          stripeCheckoutSessionId: 'cs_test_123',
          stripePaymentIntentId: 'pi_123',
          stripeSubscriptionId: null,
        },
        expect.anything(),
      );
      expect(
        checkoutOrderService.linkCheckoutSessionToCreditSlot,
      ).toHaveBeenCalledWith(
        { stripeCheckoutSessionId: 'cs_test_123', creditSlotId: 'lote-1' },
        expect.anything(),
      );
    });

    /** El lote, el cierre y el vínculo quedan o no quedan los tres juntos. */
    it('lo hace todo dentro de una transacción', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());

      const { markCompleted, linkCheckoutSessionToCreditSlot } =
        checkoutOrderService;
      expect(markCompleted.mock.calls[0][1]).toBeDefined();
      expect(linkCheckoutSessionToCreditSlot.mock.calls[0][1]).toBeDefined();
    });
  });

  /**
   * Con `adjustable_quantity` apagado lo cobrado y lo validado no deberían discrepar nunca. Si lo
   * hacen, acreditar cualquiera de los dos números sería adivinar: no se acredita, la orden se
   * queda en PENDING y el caso queda en el log para resolverse a mano.
   */
  describe('lo cobrado no cuadra con la orden', () => {
    it.each([
      ['otra cantidad', [linea({ quantity: 4 })]],
      ['otro precio de Stripe', [linea({ stripePriceId: 'price_otro' })]],
      ['otro importe', [linea({ amountSubtotal: 100 })]],
      ['otra moneda', [linea({ currency: 'usd' })]],
      ['ninguna línea', []],
      ['más de una línea', [linea(), linea()]],
    ])('no acredita si Stripe reporta %s', async (_caso, reportadas) => {
      lineas = reportadas;

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
    });

    it('acepta la moneda aunque Stripe y el catálogo difieran en mayúsculas', async () => {
      lineas = [linea({ currency: 'MXN' })];

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(1);
    });
  });

  describe('webhook duplicado', () => {
    /**
     * Primera capa de idempotencia, y la que corta la reentrega normal: la orden ya quedó
     * vinculada a su lote. Ni siquiera se le pregunta a Stripe.
     */
    it('no acredita otra vez ni consulta a Stripe si la orden ya tiene su lote', async () => {
      ordenEncontrada = orden({ creditSlotId: 'lote-ya-emitido' });

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
      expect(
        paymentGateway.listCheckoutSessionLineItems,
      ).not.toHaveBeenCalled();
    });

    /**
     * Segunda capa: el mismo pago no emite dos lotes aunque la orden hubiera quedado sin vincular
     * (una entrega anterior que reventó justo entre emitir y vincular).
     */
    it('reutiliza el lote que ya emitió ese mismo pago', async () => {
      lotePorPaymentIntent = { id: 'lote-existente' };

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(0);
      expect(
        checkoutOrderService.linkCheckoutSessionToCreditSlot,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ creditSlotId: 'lote-existente' }),
        expect.anything(),
      );
    });

    /** Dos entregas seguidas del mismo pago de 5 unidades acreditan 5 documentos, no 10. */
    it('dos entregas del mismo evento acreditan un solo lote', async () => {
      compraDeCincoDocumentosSueltos();

      await useCase.handleCheckoutSessionCompleted(sesion());
      // La segunda entrega encuentra la orden ya vinculada, como en la base real.
      ordenEncontrada = { ...ordenEncontrada!, creditSlotId: 'lote-1' };
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(1);
      expect(lotes[0]).toMatchObject({ issued: 5 });
    });
  });

  describe('eventos que no le tocan', () => {
    it('ignora las sesiones de suscripción', async () => {
      await useCase.handleCheckoutSessionCompleted(
        sesion({ mode: 'subscription' }),
      );

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
      expect(
        paymentGateway.listCheckoutSessionLineItems,
      ).not.toHaveBeenCalled();
    });

    it('ignora una sesión sin billingProfileId en la metadata', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion({ metadata: {} }));

      expect(lotes).toHaveLength(0);
    });

    it('ignora una sesión sin orden ADD_ON registrada', async () => {
      ordenEncontrada = null;

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
    });
  });

  /**
   * No poder leer a Stripe sí se arregla reintentando: el error se propaga para que el webhook
   * falle y Stripe vuelva a entregarlo, sin haber acreditado nada a medias.
   */
  it('propaga el fallo al leer a Stripe para que se reintente la entrega', async () => {
    paymentGateway.listCheckoutSessionLineItems.mockRejectedValue(
      new BadGatewayException(),
    );

    await expect(
      useCase.handleCheckoutSessionCompleted(sesion()),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(lotes).toHaveLength(0);
    expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
  });

  /**
   * Acreditar de menos estafa a quien pagó y acreditar de más regala documentos: sin saber
   * cuántos concede el paquete, no se elige ningún número.
   */
  it('no inventa una cantidad si el paquete no la declara', async () => {
    ordenEncontrada = orden({
      catalogPrice: {
        catalogItemId: 'catalog-item-1',
        stripePriceId: 'price_pack_5',
        catalogItem: { documentCreditPack: null },
      },
    });

    await useCase.handleCheckoutSessionCompleted(sesion());

    expect(lotes).toHaveLength(0);
    expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
  });
});
