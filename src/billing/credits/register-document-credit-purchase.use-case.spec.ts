import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { RegisterDocumentCreditPurchaseUseCase } from './register-document-credit-purchase.use-case';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

/**
 * Una sesión de Stripe ya completada. Por defecto es una compra de documentos de este flujo; cada
 * prueba estropea lo que necesita.
 */
function sesion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    mode: 'payment',
    payment_intent: 'pi_123',
    metadata: {
      billingProfileId: 'perfil-1',
      catalogPriceId: 'catalog-price-1',
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

/** La orden ADD_ON que se registró antes de mandar al usuario a Stripe. */
function orden(overrides: Record<string, unknown> = {}) {
  return {
    id: 'orden-1',
    creditSlotId: null,
    kind: CHECKOUT_KIND_ENUM.ADD_ON,
    catalogPrice: {
      catalogItemId: 'catalog-item-1',
      catalogItem: { documentCreditPack: { documentsGranted: 5 } },
    },
    ...overrides,
  };
}

describe('RegisterDocumentCreditPurchaseUseCase', () => {
  let useCase: RegisterDocumentCreditPurchaseUseCase;
  let checkoutOrderService: {
    markCompleted: jest.Mock;
    linkCheckoutSessionToCreditSlot: jest.Mock;
  };
  let ordenEncontrada: ReturnType<typeof orden> | null;
  /** Lotes "en la base", para poder afirmar cuántos se emitieron en total. */
  let lotes: Record<string, unknown>[];
  let lotePorPaymentIntent: Record<string, unknown> | null;

  beforeEach(async () => {
    ordenEncontrada = orden();
    lotes = [];
    lotePorPaymentIntent = null;

    checkoutOrderService = {
      markCompleted: jest.fn().mockResolvedValue(undefined),
      linkCheckoutSessionToCreditSlot: jest.fn().mockResolvedValue(undefined),
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

  describe('webhook duplicado', () => {
    /**
     * Primera capa de idempotencia, y la que corta la reentrega normal: la orden ya quedó
     * vinculada a su lote.
     */
    it('no acredita otra vez si la orden ya tiene su lote', async () => {
      ordenEncontrada = orden({ creditSlotId: 'lote-ya-emitido' });

      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
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

    /** Dos entregas seguidas del mismo evento acreditan UNA vez. */
    it('dos entregas del mismo evento acreditan un solo lote', async () => {
      await useCase.handleCheckoutSessionCompleted(sesion());
      // La segunda entrega encuentra la orden ya vinculada, como en la base real.
      ordenEncontrada = orden({ creditSlotId: 'lote-1' });
      await useCase.handleCheckoutSessionCompleted(sesion());

      expect(lotes).toHaveLength(1);
    });
  });

  describe('eventos que no le tocan', () => {
    it('ignora las sesiones de suscripción', async () => {
      await useCase.handleCheckoutSessionCompleted(
        sesion({ mode: 'subscription' }),
      );

      expect(lotes).toHaveLength(0);
      expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
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
   * Acreditar de menos estafa a quien pagó y acreditar de más regala documentos: sin saber
   * cuántos concede el paquete, no se elige ningún número.
   */
  it('no inventa una cantidad si el paquete no la declara', async () => {
    ordenEncontrada = orden({
      catalogPrice: {
        catalogItemId: 'catalog-item-1',
        catalogItem: { documentCreditPack: null },
      },
    });

    await useCase.handleCheckoutSessionCompleted(sesion());

    expect(lotes).toHaveLength(0);
    expect(checkoutOrderService.markCompleted).not.toHaveBeenCalled();
  });
});
