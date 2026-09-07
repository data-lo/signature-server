import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  RegisterSubscriptionBillingUseCase,
  type RegisterSubscriptionBillingInput,
} from './register-subscription-billing.use-case';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import {
  BillingProfileNotFoundForRegistrationException,
  InvalidBillingRegistrationException,
  PlanNotFoundForRegistrationException,
} from '../exceptions/billing.exceptions';

const PERIOD_START = new Date('2030-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2030-02-01T00:00:00.000Z');
const PAID_AT = new Date('2030-01-01T00:05:00.000Z');

/**
 * Almacén en memoria en vez de mocks sueltos por llamada.
 *
 * Lo que hay que demostrar acá es QUÉ QUEDA ESCRITO —un solo lote y no dos, un perfil que refleja
 * el periodo nuevo, un renglón que conserva el origen— y con `mockResolvedValue` eso no se puede
 * afirmar: habría que confiar en que el orden de las llamadas es el que uno cree. Acá se lee el
 * estado final y se compara.
 */
interface PerfilFalso {
  id: string;
  currentPlanType: string | null;
  status: BILLING_PROFILE_STATUS_ENUM;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

function perfil(overrides: Partial<PerfilFalso> = {}): PerfilFalso {
  return {
    id: 'profile-1',
    currentPlanType: 'free',
    status: BILLING_PROFILE_STATUS_ENUM.FREE,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...overrides,
  };
}

function cobroStripe(
  overrides: Partial<RegisterSubscriptionBillingInput> = {},
): RegisterSubscriptionBillingInput {
  return {
    billingProfileId: 'profile-1',
    source: BILLING_SOURCE_ENUM.STRIPE,
    planType: 'plus',
    amount: 149900,
    currency: 'mxn',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    paidAt: PAID_AT,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    stripeInvoiceId: 'in_1',
    stripePaymentIntentId: 'pi_1',
    ...overrides,
  };
}

function cobroManual(
  overrides: Partial<RegisterSubscriptionBillingInput> = {},
): RegisterSubscriptionBillingInput {
  return {
    billingProfileId: 'profile-1',
    source: BILLING_SOURCE_ENUM.MANUAL,
    planType: 'plus',
    amount: 149900,
    currency: 'mxn',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    paidAt: PAID_AT,
    externalReference: 'TRF-4471',
    createdByUserId: 'user-admin',
    notes: 'Transferencia recibida el 1 de enero',
    ...overrides,
  };
}

describe('RegisterSubscriptionBillingUseCase', () => {
  let useCase: RegisterSubscriptionBillingUseCase;
  let perfiles: PerfilFalso[];
  let lotes: Record<string, unknown>[];
  let historial: Record<string, unknown>[];
  let planes: { planType: string; documentsIncluded: number }[];
  let checkoutOrderService: {
    linkCompletedSubscriptionToCreditSlot: jest.Mock;
  };
  let transaction: jest.Mock;
  let opcionesDeBloqueo: unknown[];
  let rolloverExecute: jest.Mock;
  let historyRepository: { save: jest.Mock };

  beforeEach(async () => {
    perfiles = [perfil()];
    lotes = [];
    historial = [];
    planes = [{ planType: 'plus', documentsIncluded: 100 }];
    opcionesDeBloqueo = [];

    rolloverExecute = jest.fn().mockResolvedValue({ affected: 0 });

    const repositorioDe = (entity: unknown) => ({
      findOne: jest.fn(async (options: any) => {
        const filas = entity === CreditLotEntity ? lotes : historial;
        return (
          filas.find((fila) =>
            Object.entries(options.where).every(
              ([campo, valor]) => fila[campo] === valor,
            ),
          ) ?? null
        );
      }),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (data: Record<string, unknown>) => {
        const filas = entity === CreditLotEntity ? lotes : historial;
        const fila = {
          id: `${entity === CreditLotEntity ? 'lot' : 'period'}-${filas.length + 1}`,
          ...data,
        };
        filas.push(fila);
        return fila;
      }),
    });

    const repositorios = new Map<unknown, ReturnType<typeof repositorioDe>>([
      [CreditLotEntity, repositorioDe(CreditLotEntity)],
      [
        SubscriptionBillingHistoryEntity,
        repositorioDe(SubscriptionBillingHistoryEntity),
      ],
    ]);

    historyRepository = repositorios.get(
      SubscriptionBillingHistoryEntity,
    ) as unknown as { save: jest.Mock };

    const manager = {
      findOne: jest.fn(async (entity: unknown, options: any) => {
        if (entity === BillingProfileEntity) {
          opcionesDeBloqueo.push(options.lock);
          const encontrado = perfiles.find((p) => p.id === options.where.id);
          return encontrado ? { ...encontrado } : null;
        }

        if (entity === PlanEntity) {
          return (
            planes.find((p) => p.planType === options.where.planType) ?? null
          );
        }

        throw new Error(`findOne inesperado sobre ${String(entity)}`);
      }),
      update: jest.fn(async (entity: unknown, criteria: any, cambios: any) => {
        if (entity !== BillingProfileEntity) {
          throw new Error(`update inesperado sobre ${String(entity)}`);
        }
        Object.assign(
          perfiles.find((p) => p.id === criteria) as PerfilFalso,
          cambios,
        );
        return { affected: 1 };
      }),
      getRepository: jest.fn((entity: unknown) => repositorios.get(entity)),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: rolloverExecute,
      }),
    };

    transaction = jest.fn(async (work: (m: unknown) => Promise<unknown>) =>
      work(manager),
    );

    checkoutOrderService = {
      linkCompletedSubscriptionToCreditSlot: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterSubscriptionBillingUseCase,
        {
          provide: getDataSourceToken(),
          useValue: { transaction } as unknown as DataSource,
        },
        { provide: CheckoutOrderService, useValue: checkoutOrderService },
      ],
    }).compile();

    useCase = module.get(RegisterSubscriptionBillingUseCase);
  });

  describe('renovación cobrada por Stripe', () => {
    it('registra el periodo con origen STRIPE y sus ids de rastreo', async () => {
      const { history, alreadyRegistered } =
        await useCase.execute(cobroStripe());

      expect(alreadyRegistered).toBe(false);
      expect(history).toMatchObject({
        billingProfileId: 'profile-1',
        source: BILLING_SOURCE_ENUM.STRIPE,
        planType: 'plus',
        amount: 149900,
        currency: 'mxn',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        paidAt: PAID_AT,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        stripeInvoiceId: 'in_1',
        stripePaymentIntentId: 'pi_1',
        externalReference: null,
        createdByUserId: null,
      });
      expect(historial).toHaveLength(1);
    });

    it('emite un único lote con los documentos del plan', async () => {
      await useCase.execute(cobroStripe());

      expect(lotes).toHaveLength(1);
      expect(lotes[0]).toMatchObject({
        billingProfileId: 'profile-1',
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
        issued: 100,
        remaining: 100,
        stripeInvoiceId: 'in_1',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      });
    });

    it('deja el perfil describiendo el plan y el periodo vigentes', async () => {
      await useCase.execute(cobroStripe());

      expect(perfiles[0]).toMatchObject({
        currentPlanType: 'plus',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
      });
    });

    it('vincula el lote con el historial y con la orden de compra del alta', async () => {
      checkoutOrderService.linkCompletedSubscriptionToCreditSlot.mockResolvedValue(
        'order-1',
      );

      const { history } = await useCase.execute(cobroStripe());

      expect(history.creditSlotId).toBe(lotes[0].id);
      expect(history.checkoutOrderId).toBe('order-1');
      expect(
        checkoutOrderService.linkCompletedSubscriptionToCreditSlot,
      ).toHaveBeenCalledWith(
        {
          billingProfileId: 'profile-1',
          stripeSubscriptionId: 'sub_1',
          creditSlotId: lotes[0].id,
        },
        expect.anything(),
      );
    });

    it('arrastra a ROLLOVER el saldo sin gastar del periodo anterior', async () => {
      rolloverExecute.mockResolvedValue({ affected: 1 });

      await useCase.execute(cobroStripe());

      expect(rolloverExecute).toHaveBeenCalledTimes(1);
    });

    /**
     * Una renovación no pasa por Checkout, así que no hay orden nueva que apuntar. Que el vínculo
     * quede nulo es lo correcto, no un fallo de resolución.
     */
    it('deja la orden de compra en nulo cuando no hay ninguna que vincular', async () => {
      const { history } = await useCase.execute(cobroStripe());

      expect(history.checkoutOrderId).toBeNull();
    });
  });

  describe('cobro registrado manualmente', () => {
    it('registra el periodo con origen MANUAL y su rastro interno', async () => {
      const { history } = await useCase.execute(cobroManual());

      expect(history).toMatchObject({
        source: BILLING_SOURCE_ENUM.MANUAL,
        planType: 'plus',
        amount: 149900,
        externalReference: 'TRF-4471',
        createdByUserId: 'user-admin',
        notes: 'Transferencia recibida el 1 de enero',
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
        stripeCustomerId: null,
        stripePaymentIntentId: null,
      });
      expect(lotes).toHaveLength(1);
    });

    it('actualiza el perfil igual que un cobro de Stripe', async () => {
      await useCase.execute(cobroManual());

      expect(perfiles[0]).toMatchObject({
        currentPlanType: 'plus',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      });
    });

    /**
     * Un cobro manual no aporta ids de Stripe, y ponerlos a `null` desde acá tiraría el vínculo
     * con cobros reales que todavía hay que poder consultar — un cliente que venía de Stripe y
     * pasa a facturación manual conserva su historia.
     */
    it('no borra los ids de Stripe que el perfil ya tuviera', async () => {
      perfiles[0] = perfil({
        stripeCustomerId: 'cus_viejo',
        stripeSubscriptionId: 'sub_viejo',
      });

      await useCase.execute(cobroManual());

      expect(perfiles[0]).toMatchObject({
        stripeCustomerId: 'cus_viejo',
        stripeSubscriptionId: 'sub_viejo',
      });
    });

    it('acredita los documentos pactados cuando se indican en vez de los del plan', async () => {
      await useCase.execute(cobroManual({ documentsGranted: 500 }));

      expect(lotes[0]).toMatchObject({ issued: 500, remaining: 500 });
    });

    /** Sirve igual para una cuenta personal que para una organización: el perfil ya sabe de quién es. */
    it('funciona sobre cualquier perfil, sea de persona o de organización', async () => {
      perfiles.push(perfil({ id: 'profile-org' }));

      const { history } = await useCase.execute(
        cobroManual({ billingProfileId: 'profile-org' }),
      );

      expect(history.billingProfileId).toBe('profile-org');
      expect(perfiles[1].status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
    });
  });

  describe('idempotencia', () => {
    /** Stripe reintenta las entregas durante días: la misma factura no puede acreditar dos veces. */
    it('no duplica nada si la misma factura de Stripe llega otra vez', async () => {
      const primera = await useCase.execute(cobroStripe());
      const perfilTrasLaPrimera = { ...perfiles[0] };

      const segunda = await useCase.execute(cobroStripe());

      expect(segunda.alreadyRegistered).toBe(true);
      expect(segunda.history.id).toBe(primera.history.id);
      expect(historial).toHaveLength(1);
      expect(lotes).toHaveLength(1);
      expect(perfiles[0]).toEqual(perfilTrasLaPrimera);
    });

    it('no duplica nada si la referencia manual ya se registró en ese perfil', async () => {
      const primera = await useCase.execute(cobroManual());

      // Datos distintos a propósito: lo que desduplica es el folio, no que el resto coincida.
      const segunda = await useCase.execute(
        cobroManual({
          amount: 999,
          periodStart: PERIOD_END,
          periodEnd: new Date('2030-03-01T00:00:00.000Z'),
        }),
      );

      expect(segunda.alreadyRegistered).toBe(true);
      expect(segunda.history.id).toBe(primera.history.id);
      expect(historial).toHaveLength(1);
      expect(lotes).toHaveLength(1);
    });

    /**
     * La misma referencia en OTRO perfil es un cobro distinto: el folio identifica el movimiento
     * dentro de la cuenta, no en toda la plataforma.
     */
    it('permite la misma referencia en un perfil distinto', async () => {
      perfiles.push(perfil({ id: 'profile-2' }));

      await useCase.execute(cobroManual());
      const segunda = await useCase.execute(
        cobroManual({ billingProfileId: 'profile-2' }),
      );

      expect(segunda.alreadyRegistered).toBe(false);
      expect(historial).toHaveLength(2);
    });

    /**
     * `credit_lots.stripe_invoice_id` es anterior al historial, así que una base que ya operaba
     * puede tener lotes de facturas que nunca dejaron renglón. Emitir uno nuevo chocaría contra su
     * índice único y dejaría el webhook fallando en bucle.
     */
    it('reutiliza el lote que esa factura ya hubiera emitido sin historial', async () => {
      lotes.push({
        id: 'lot-preexistente',
        billingProfileId: 'profile-1',
        stripeInvoiceId: 'in_1',
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
      });

      const { history } = await useCase.execute(cobroStripe());

      expect(lotes).toHaveLength(1);
      expect(history.creditSlotId).toBe('lot-preexistente');
      // No se arrastra: ese lote SIGUE siendo el del periodo vigente, no el de uno anterior.
      expect(rolloverExecute).not.toHaveBeenCalled();
    });

    /**
     * Sin folio no hay clave que distinga "el mismo cobro otra vez" de "un segundo cobro idéntico":
     * dos meses seguidos del mismo plan por el mismo importe son legítimamente iguales.
     */
    it('no intenta desduplicar un cobro manual sin referencia externa', async () => {
      const input = cobroManual({ externalReference: null });

      await useCase.execute(input);
      const segunda = await useCase.execute(input);

      expect(segunda.alreadyRegistered).toBe(false);
      expect(historial).toHaveLength(2);
    });
  });

  describe('transacción y bloqueo', () => {
    it('hace todo dentro de una sola transacción', async () => {
      await useCase.execute(cobroStripe());

      expect(transaction).toHaveBeenCalledTimes(1);
    });

    /**
     * El bloqueo serializa los cobros del mismo perfil, y es lo que hace fiable la comprobación de
     * idempotencia: leerla sin bloquear dejaría pasar dos entregas simultáneas de la misma factura.
     */
    it('bloquea el perfil antes de tocar nada', async () => {
      await useCase.execute(cobroStripe());

      expect(opcionesDeBloqueo).toEqual([{ mode: 'pessimistic_write' }]);
    });

    /**
     * El perfil se actualiza DESPUÉS del historial, así que un fallo al escribirlo —el índice
     * único saltando en una carrera— tiene que dejar el perfil intacto. En producción lo garantiza
     * el rollback; acá se comprueba que el orden de las escrituras no adelanta el efecto visible
     * al cliente antes de que el registro esté firme.
     */
    it('no toca el perfil si el alta del historial falla', async () => {
      historyRepository.save.mockRejectedValueOnce(new Error('índice único'));

      await expect(useCase.execute(cobroStripe())).rejects.toThrow(
        'índice único',
      );
      expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.FREE);
      expect(perfiles[0].currentPlanType).toBe('free');
    });
  });

  describe('validaciones', () => {
    it('rechaza un perfil de facturación inexistente', async () => {
      await expect(
        useCase.execute(cobroManual({ billingProfileId: 'profile-fantasma' })),
      ).rejects.toBeInstanceOf(BillingProfileNotFoundForRegistrationException);
      expect(lotes).toHaveLength(0);
      expect(historial).toHaveLength(0);
    });

    it('rechaza un plan que no está en el catálogo local', async () => {
      await expect(
        useCase.execute(cobroManual({ planType: 'inexistente' })),
      ).rejects.toBeInstanceOf(PlanNotFoundForRegistrationException);
      expect(lotes).toHaveLength(0);
    });

    it.each([
      ['un importe negativo', cobroManual({ amount: -1 })],
      ['un importe con decimales', cobroManual({ amount: 10.5 })],
      [
        'una moneda que no es ISO de tres letras',
        cobroManual({ currency: 'peso' }),
      ],
      [
        'un periodo que termina antes de empezar',
        cobroManual({ periodStart: PERIOD_END, periodEnd: PERIOD_START }),
      ],
      [
        'un periodo de duración cero',
        cobroManual({ periodStart: PERIOD_START, periodEnd: PERIOD_START }),
      ],
      ['cero documentos a acreditar', cobroManual({ documentsGranted: 0 })],
      [
        'un cobro de Stripe sin factura',
        cobroStripe({ stripeInvoiceId: null }),
      ],
      [
        'un cobro manual sin folio ni autor',
        cobroManual({ externalReference: null, createdByUserId: null }),
      ],
    ])('rechaza %s', async (_caso, input) => {
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(
        InvalidBillingRegistrationException,
      );
    });

    /** Se valida antes de abrir la transacción: no tiene sentido bloquear una fila para nada. */
    it('no abre transacción si los datos ya vienen mal', async () => {
      await expect(
        useCase.execute(cobroManual({ amount: -1 })),
      ).rejects.toBeInstanceOf(InvalidBillingRegistrationException);
      expect(transaction).not.toHaveBeenCalled();
    });
  });
});
