import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Stripe = require('stripe');
import { FinalizeSubscriptionFromStripeUseCase } from './finalize-subscription-from-stripe.use-case';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { SUBSCRIPTION_END_REASON_ENUM } from '../enums/subscription-end-reason.enum';
import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';

const PERIOD_START = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END = 1896134400; // 2030-02-01T00:00:00Z
const ENDED_AT = 1896134401; // un segundo después del fin del periodo

/**
 * Almacén en memoria en vez de mocks sueltos por llamada.
 *
 * Casi todo lo que hay que demostrar es QUÉ QUEDA ESCRITO —un solo renglón y no dos, el plan
 * pagado y no `free`, un `ended_at` que no se reescribe en la segunda entrega— y eso con
 * `mockResolvedValue` no se puede afirmar: habría que confiar en que el orden de las llamadas es
 * el que uno cree. Acá se lee el estado final y se compara.
 */
interface PerfilFalso {
  id: string;
  status: BILLING_PROFILE_STATUS_ENUM;
  currentPlanType: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

function perfilDePago(overrides: Partial<PerfilFalso> = {}): PerfilFalso {
  return {
    id: 'profile-1',
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    currentPlanType: 'plus',
    cancelAtPeriodEnd: true,
    currentPeriodStart: new Date(PERIOD_START * 1000),
    currentPeriodEnd: new Date(PERIOD_END * 1000),
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    ...overrides,
  };
}

function bajaDeStripe(
  overrides: Record<string, unknown> = {},
): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'canceled',
    cancel_at_period_end: true,
    ended_at: ENDED_AT,
    canceled_at: PERIOD_START,
    cancellation_details: { reason: 'cancellation_requested' },
    items: {
      data: [
        {
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe('FinalizeSubscriptionFromStripeUseCase', () => {
  let useCase: FinalizeSubscriptionFromStripeUseCase;
  let perfiles: PerfilFalso[];
  let historial: Record<string, unknown>[];
  let managerUpdate: jest.Mock;
  let opcionesDeBloqueo: unknown[];

  beforeEach(async () => {
    perfiles = [perfilDePago()];
    historial = [];
    opcionesDeBloqueo = [];

    const billingProfileRepository = {
      findOne: jest.fn(async (options: any) => {
        const { stripeSubscriptionId, stripeCustomerId } = options.where;
        return (
          perfiles.find((perfil) =>
            stripeSubscriptionId
              ? perfil.stripeSubscriptionId === stripeSubscriptionId
              : perfil.stripeCustomerId === stripeCustomerId,
          ) ?? null
        );
      }),
    };

    const historyRepository = {
      findOne: jest.fn(async (options: any) => {
        const { billingProfileId, stripeSubscriptionId } = options.where;
        return (
          historial.find(
            (fila) =>
              fila.billingProfileId === billingProfileId &&
              fila.stripeSubscriptionId === stripeSubscriptionId,
          ) ?? null
        );
      }),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (data: Record<string, unknown>) => {
        const fila = { id: `period-${historial.length + 1}`, ...data };
        historial.push(fila);
        return fila;
      }),
    };

    managerUpdate = jest.fn(
      async (entity: unknown, criteria: any, cambios: any) => {
        if (entity === BillingProfileEntity) {
          Object.assign(
            perfiles.find((p) => p.id === criteria) as PerfilFalso,
            cambios,
          );
          return { affected: 1 };
        }

        if (entity === SubscriptionBillingHistoryEntity) {
          const alcanzados = historial.filter(
            (fila) =>
              fila.id === criteria.id && fila.status === criteria.status,
          );
          alcanzados.forEach((fila) => Object.assign(fila, cambios));
          return { affected: alcanzados.length };
        }

        throw new Error(`No debería escribirse en ${String(entity)}`);
      },
    );

    const manager = {
      findOne: jest.fn(async (entity: unknown, options: any) => {
        expect(entity).toBe(BillingProfileEntity);
        opcionesDeBloqueo.push(options.lock);
        const perfil = perfiles.find((p) => p.id === options.where.id);
        return perfil ? { ...perfil } : null;
      }),
      update: managerUpdate,
      getRepository: jest.fn((entity: unknown) => {
        expect(entity).toBe(SubscriptionBillingHistoryEntity);
        return historyRepository;
      }),
    };

    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) =>
        work(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinalizeSubscriptionFromStripeUseCase,
        {
          provide: getDataSourceToken(),
          useValue: dataSource as unknown as DataSource,
        },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
      ],
    }).compile();

    useCase = module.get(FinalizeSubscriptionFromStripeUseCase);
  });

  describe('término de una cancelación programada', () => {
    it('devuelve el perfil al plan gratuito', async () => {
      await useCase.execute(bajaDeStripe());

      expect(perfiles[0]).toMatchObject({
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
      });
    });

    /**
     * Lo que se conserva es lo que sirve para auditar: el cliente es el mismo para siempre, la
     * suscripción localiza este ciclo en el panel de Stripe, y `current_period_end` responde
     * "¿hasta cuándo tuvo servicio?".
     */
    it('conserva las referencias de Stripe y la fecha final', async () => {
      await useCase.execute(bajaDeStripe());

      expect(perfiles[0]).toMatchObject({
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        currentPeriodEnd: new Date(PERIOD_END * 1000),
      });
    });

    it('registra el cierre en el historial con el plan que se pagó', async () => {
      await useCase.execute(bajaDeStripe());

      expect(historial).toHaveLength(1);
      expect(historial[0]).toMatchObject({
        billingProfileId: 'profile-1',
        planType: 'plus',
        source: BILLING_SOURCE_ENUM.STRIPE,
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        endedReason: SUBSCRIPTION_END_REASON_ENUM.CANCELED_AT_PERIOD_END,
        endedAt: new Date(ENDED_AT * 1000),
        periodStart: new Date(PERIOD_START * 1000),
        periodEnd: new Date(PERIOD_END * 1000),
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
      });
    });

    /**
     * El plan se lee del perfil ANTES de degradarlo. Leerlo después guardaría `free` en todos los
     * renglones, que es justo lo que esta tabla existe para evitar.
     */
    it('no sobrescribe el plan del historial con free', async () => {
      await useCase.execute(bajaDeStripe());

      expect(historial[0].planType).not.toBe(FREE_PLAN_TYPE);
      expect(historial[0].planType).toBe('plus');
    });

    it('bloquea el perfil antes de escribir', async () => {
      await useCase.execute(bajaDeStripe());

      expect(opcionesDeBloqueo).toEqual([{ mode: 'pessimistic_write' }]);
    });

    /**
     * El `manager` de las pruebas lanza ante cualquier otra entidad, así que estas dos son las
     * únicas tablas que el caso de uso puede haber tocado. Los lotes de créditos y las órdenes de
     * compra son la prueba de lo que el cliente pagó y consumió: perder el plan no le quita lo
     * comprado.
     */
    it('no toca créditos ni órdenes de compra', async () => {
      await useCase.execute(bajaDeStripe());

      const entidadesEscritas = managerUpdate.mock.calls.map(
        ([entity]) => entity,
      );
      expect(entidadesEscritas).toEqual([BillingProfileEntity]);
      expect(entidadesEscritas).not.toContain(CreditLotEntity);
      expect(entidadesEscritas).not.toContain(CheckoutOrderEntity);
    });
  });

  describe('cierre de un periodo ya registrado', () => {
    beforeEach(() => {
      historial.push({
        id: 'period-existente',
        billingProfileId: 'profile-1',
        planType: 'plus',
        source: BILLING_SOURCE_ENUM.STRIPE,
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
        stripeSubscriptionId: 'sub_1',
        endedAt: null,
        endedReason: null,
      });
    });

    /** Si el periodo ya estaba anotado, se CIERRA en vez de abrir un segundo renglón. */
    it('actualiza el renglón vigente en lugar de crear otro', async () => {
      await useCase.execute(bajaDeStripe());

      expect(historial).toHaveLength(1);
      expect(historial[0]).toMatchObject({
        id: 'period-existente',
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        endedReason: SUBSCRIPTION_END_REASON_ENUM.CANCELED_AT_PERIOD_END,
        endedAt: new Date(ENDED_AT * 1000),
        planType: 'plus',
      });
    });
  });

  describe('idempotencia', () => {
    /**
     * Stripe reintenta las entregas: la segunda pasada no puede duplicar el renglón ni volver a
     * escribir el `ended_at`, que es el registro de cuándo terminó de verdad.
     */
    it('una segunda entrega no cambia nada de lo que dejó la primera', async () => {
      await useCase.execute(bajaDeStripe());
      const trasLaPrimera = {
        perfil: { ...perfiles[0] },
        historial: historial.map((fila) => ({ ...fila })),
      };

      await useCase.execute(bajaDeStripe({ ended_at: ENDED_AT + 3600 }));

      expect(historial).toHaveLength(1);
      expect(historial[0]).toEqual(trasLaPrimera.historial[0]);
      expect(perfiles[0]).toEqual(trasLaPrimera.perfil);
    });

    /**
     * El caso que pide la historia: el perfil ya está en FREE y corresponde a la misma
     * suscripción, así que la operación termina de forma segura y sin escribir.
     */
    it('termina sin hacer nada si el perfil ya está en FREE por esa suscripción', async () => {
      await useCase.execute(bajaDeStripe());
      managerUpdate.mockClear();

      await useCase.execute(bajaDeStripe());

      expect(managerUpdate).not.toHaveBeenCalled();
    });
  });

  describe('perfil inexistente', () => {
    /**
     * Un 5xx haría que Stripe reintentara durante días algo que ningún reintento arregla: si el
     * perfil no está vinculado ni por suscripción ni por cliente, el vínculo no aparece solo.
     */
    it('avisa con los tres datos y no falla la entrega', async () => {
      const warn = jest.spyOn(useCase['logger'], 'warn').mockImplementation();
      perfiles = [];

      await expect(useCase.execute(bajaDeStripe())).resolves.toBeUndefined();

      const mensaje = warn.mock.calls[0][0] as string;
      expect(mensaje).toContain('sub_1');
      expect(mensaje).toContain('cus_1');
      expect(mensaje).toContain('canceled');
      expect(historial).toHaveLength(0);
    });

    /**
     * El respaldo por cliente importa incluso en la baja: un perfil cuyo `stripe_subscription_id`
     * nunca llegó a grabarse sigue teniendo su cliente, que se escribe antes de abrir el checkout.
     */
    it('encuentra el perfil por cliente cuando la suscripción no está grabada', async () => {
      perfiles = [perfilDePago({ stripeSubscriptionId: null })];

      await useCase.execute(bajaDeStripe());

      expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.FREE);
      expect(historial).toHaveLength(1);
    });
  });

  describe('clasificación del término', () => {
    it.each([
      [
        'payment_failed',
        SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
        SUBSCRIPTION_END_REASON_ENUM.PAYMENT_FAILURE,
      ],
      [
        'cancellation_requested',
        SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        SUBSCRIPTION_END_REASON_ENUM.CANCELED_AT_PERIOD_END,
      ],
      [
        'payment_disputed',
        SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        SUBSCRIPTION_END_REASON_ENUM.STRIPE_TERMINATED,
      ],
      [
        'canceled_by_retention_policy',
        SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        SUBSCRIPTION_END_REASON_ENUM.STRIPE_TERMINATED,
      ],
    ])('traduce %s de Stripe a %s / %s', async (motivo, status, reason) => {
      await useCase.execute(
        bajaDeStripe({
          cancel_at_period_end: false,
          cancellation_details: { reason: motivo },
        }),
      );

      expect(historial[0]).toMatchObject({ status, endedReason: reason });
    });

    /**
     * El respaldo para las bajas anteriores a que Stripe informara `cancellation_details`: ahí la
     * bandera es la única evidencia de que la baja se había pedido.
     */
    it('usa cancel_at_period_end cuando Stripe no informa el motivo', async () => {
      await useCase.execute(
        bajaDeStripe({
          cancellation_details: null,
          cancel_at_period_end: true,
        }),
      );

      expect(historial[0]).toMatchObject({
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        endedReason: SUBSCRIPTION_END_REASON_ENUM.CANCELED_AT_PERIOD_END,
      });
    });

    it('un término sin motivo ni baja programada queda como terminado por Stripe', async () => {
      await useCase.execute(
        bajaDeStripe({
          cancellation_details: null,
          cancel_at_period_end: false,
        }),
      );

      expect(historial[0].endedReason).toBe(
        SUBSCRIPTION_END_REASON_ENUM.STRIPE_TERMINATED,
      );
    });
  });

  describe('fechas y datos incompletos del evento', () => {
    it('cae a canceled_at cuando el evento no trae ended_at', async () => {
      await useCase.execute(bajaDeStripe({ ended_at: null }));

      expect(historial[0].endedAt).toEqual(new Date(PERIOD_START * 1000));
    });

    /**
     * Sin fecha, el CHECK de la tabla rechazaría el cierre y el webhook fallaría en bucle por un
     * dato que el proveedor no mandó.
     */
    it('cae a "ahora" si el evento no trae ninguna fecha de término', async () => {
      const antes = Date.now();

      await useCase.execute(
        bajaDeStripe({ ended_at: null, canceled_at: null }),
      );

      const endedAt = historial[0].endedAt as Date;
      expect(endedAt.getTime()).toBeGreaterThanOrEqual(antes);
    });

    /** Una suscripción ya terminada suele llegar sin items; el periodo del perfil es el respaldo. */
    it('toma el periodo del perfil si el evento no trae items', async () => {
      await useCase.execute(bajaDeStripe({ items: { data: [] } }));

      expect(historial[0]).toMatchObject({
        periodStart: new Date(PERIOD_START * 1000),
        periodEnd: new Date(PERIOD_END * 1000),
      });
    });

    /**
     * El historial registra periodos facturados, y el plan gratuito no factura: antes que mentir
     * diciendo que se pagó por el gratuito, el renglón se queda sin plan.
     */
    it('deja el plan en nulo si el perfil ya venía en Free', async () => {
      perfiles = [
        perfilDePago({
          currentPlanType: FREE_PLAN_TYPE,
          status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        }),
      ];

      await useCase.execute(bajaDeStripe());

      expect(historial[0].planType).toBeNull();
    });
  });
});
