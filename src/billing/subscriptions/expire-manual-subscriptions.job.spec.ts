import { Test, TestingModule } from '@nestjs/testing';
import { CronExpression } from '@nestjs/schedule';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator } from 'typeorm';
import {
  EXPIRE_MANUAL_SUBSCRIPTIONS_JOB,
  ExpireManualSubscriptionsJob,
} from './expire-manual-subscriptions.job';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { BILLING_PERIOD_END_REASON_ENUM } from '../enums/billing-period-end-reason.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';

const AHORA = new Date('2030-06-15T12:00:00.000Z');
const AYER = new Date('2030-06-14T12:00:00.000Z');
const MANANA = new Date('2030-06-16T12:00:00.000Z');

/**
 * Las pruebas corren contra un almacén en memoria en vez de contra mocks sueltos por llamada.
 *
 * La diferencia importa acá más que en otros servicios: casi todo lo que hay que demostrar es
 * QUÉ QUEDA ESCRITO después de una o dos pasadas —que la segunda no reescriba el `ended_at` de la
 * primera, que un perfil ajeno no se mueva, que el `current_period_end` sobreviva—, y eso con
 * `mockResolvedValue` no se puede afirmar: habría que confiar en que el orden de las llamadas es
 * el que uno cree. Acá se lee el estado final y se compara.
 */
interface PerfilFalso {
  id: string;
  billingSource: BILLING_SOURCE_ENUM;
  status: BILLING_PROFILE_STATUS_ENUM;
  currentPlanType: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
}

interface PeriodoFalso {
  id: string;
  billingProfileId: string;
  source: BILLING_SOURCE_ENUM;
  status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM;
  periodEnd: Date | null;
  endedAt: Date | null;
  endedReason: BILLING_PERIOD_END_REASON_ENUM | null;
}

function perfilManualVencido(
  overrides: Partial<PerfilFalso> = {},
): PerfilFalso {
  return {
    id: 'profile-manual',
    billingSource: BILLING_SOURCE_ENUM.MANUAL,
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    currentPlanType: 'plus',
    currentPeriodStart: new Date('2030-05-15T12:00:00.000Z'),
    currentPeriodEnd: AYER,
    cancelAtPeriodEnd: true,
    stripeSubscriptionId: null,
    ...overrides,
  };
}

function periodoManualVigente(
  overrides: Partial<PeriodoFalso> = {},
): PeriodoFalso {
  return {
    id: 'period-manual',
    billingProfileId: 'profile-manual',
    source: BILLING_SOURCE_ENUM.MANUAL,
    status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
    periodEnd: AYER,
    endedAt: null,
    endedReason: null,
    ...overrides,
  };
}

describe('ExpireManualSubscriptionsJob', () => {
  let job: ExpireManualSubscriptionsJob;
  let perfiles: PerfilFalso[];
  let periodos: PeriodoFalso[];
  /** Perfiles que otra instancia tiene bloqueados; `skip_locked` los devuelve como `null`. */
  let bloqueadosPorOtraInstancia: Set<string>;
  let opcionesDeBloqueo: unknown[];
  let filtroDeCandidatos: Record<string, unknown> | null;
  let managerUpdate: jest.Mock;
  let managerFindOne: jest.Mock;

  beforeEach(async () => {
    perfiles = [];
    periodos = [];
    bloqueadosPorOtraInstancia = new Set();
    opcionesDeBloqueo = [];
    filtroDeCandidatos = null;

    const billingProfileRepository = {
      find: jest.fn(async (options: any) => {
        filtroDeCandidatos = options.where;
        const limite = options.where.currentPeriodEnd as FindOperator<Date>;
        return perfiles
          .filter(
            (perfil) =>
              perfil.billingSource === options.where.billingSource &&
              perfil.status === options.where.status &&
              perfil.currentPeriodEnd !== null &&
              perfil.currentPeriodEnd.getTime() <=
                (limite.value as Date).getTime(),
          )
          .map((perfil) => ({ id: perfil.id }));
      }),
    };

    const historyRepository = {
      findOne: jest.fn(async (options: any) => {
        const { billingProfileId, status } = options.where;
        return (
          periodos.find(
            (periodo) =>
              periodo.billingProfileId === billingProfileId &&
              periodo.status === status,
          ) ?? null
        );
      }),
    };

    managerFindOne = jest.fn(async (entity: unknown, options: any) => {
      expect(entity).toBe(BillingProfileEntity);
      opcionesDeBloqueo.push(options.lock);

      if (bloqueadosPorOtraInstancia.has(options.where.id)) {
        return null;
      }

      const perfil = perfiles.find((p) => p.id === options.where.id);
      return perfil ? { ...perfil } : null;
    });

    managerUpdate = jest.fn(
      async (entity: unknown, criteria: any, cambios: any) => {
        if (entity === BillingProfileEntity) {
          const perfil = perfiles.find((p) => p.id === criteria);
          Object.assign(perfil as PerfilFalso, cambios);
          return { affected: 1 };
        }

        if (entity === SubscriptionBillingHistoryEntity) {
          const alcanzados = periodos.filter(
            (periodo) =>
              periodo.id === criteria.id && periodo.status === criteria.status,
          );
          alcanzados.forEach((periodo) => Object.assign(periodo, cambios));
          return { affected: alcanzados.length };
        }

        throw new Error(`El job no debería escribir en ${String(entity)}`);
      },
    );

    const manager = {
      findOne: managerFindOne,
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
        ExpireManualSubscriptionsJob,
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

    job = module.get(ExpireManualSubscriptionsJob);
  });

  describe('expiración de un periodo manual terminado', () => {
    beforeEach(() => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente());
    });

    it('devuelve el perfil a plan Free y le quita el gobierno manual', async () => {
      const resumen = await job.run(AHORA);

      expect(resumen).toEqual({
        candidates: 1,
        expired: 1,
        skipped: 0,
        failed: 0,
      });
      expect(perfiles[0]).toMatchObject({
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        billingSource: BILLING_SOURCE_ENUM.FREE,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
      });
    });

    /**
     * Es la única fecha que sobrevive a la expiración, y a propósito: responde "¿hasta cuándo
     * tuvo plan este cliente?" y es lo que permite ofrecerle una renovación. Anularla dejaría un
     * perfil Free indistinguible de uno que nunca contrató.
     */
    it('conserva `current_period_end` como referencia histórica', async () => {
      await job.run(AHORA);

      expect(perfiles[0].currentPeriodEnd).toEqual(AYER);
    });

    it('marca el periodo del historial como EXPIRED con motivo y fecha', async () => {
      await job.run(AHORA);

      expect(periodos[0]).toMatchObject({
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
        endedAt: AHORA,
        endedReason: BILLING_PERIOD_END_REASON_ENUM.MANUAL_PERIOD_ENDED,
      });
      // El origen NO se reescribe: el periodo se facturó a mano y eso no cambia al vencer.
      expect(periodos[0].source).toBe(BILLING_SOURCE_ENUM.MANUAL);
    });

    /**
     * El `manager` de las pruebas lanza ante cualquier otra entidad, así que estas dos son las
     * únicas tablas que el job puede haber tocado. Los `credit_lots` y los `checkout_orders` son
     * la prueba de lo que el cliente pagó y consumió: perder el plan no le quita lo comprado.
     */
    it('no escribe en ninguna tabla más que el perfil y su historial', async () => {
      await job.run(AHORA);

      const entidadesEscritas = managerUpdate.mock.calls.map(
        ([entity]) => entity,
      );
      expect(entidadesEscritas).toEqual([
        SubscriptionBillingHistoryEntity,
        BillingProfileEntity,
      ]);
      expect(entidadesEscritas).not.toContain(CreditLotEntity);
      expect(entidadesEscritas).not.toContain(CheckoutOrderEntity);
    });

    it('bloquea el perfil antes de escribir, sin esperar a otras instancias', async () => {
      await job.run(AHORA);

      expect(opcionesDeBloqueo).toEqual([
        { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      ]);
    });
  });

  describe('renovación anticipada', () => {
    /**
     * El caso que la historia pide explícitamente: si un administrador registra una renovación
     * manual antes de que venza el periodo anterior, el cron NO debe devolver el perfil a Free.
     * Acá el perfil ya no cumple la condición de vencido cuando se lo bloquea.
     */
    it('no expira el perfil cuyo periodo se empujó hacia adelante entre la lectura y el bloqueo', async () => {
      const perfil = perfilManualVencido();
      perfiles.push(perfil);
      periodos.push(periodoManualVigente({ periodEnd: MANANA }));

      managerFindOne.mockImplementationOnce(async () => ({
        ...perfil,
        currentPeriodEnd: MANANA,
      }));

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ expired: 0, skipped: 1 });
      expect(perfil.status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
      expect(perfil.billingSource).toBe(BILLING_SOURCE_ENUM.MANUAL);
      expect(managerUpdate).not.toHaveBeenCalled();
    });

    /**
     * Segunda red, por si el perfil se quedara atrás: el historial dice que hay un periodo manual
     * todavía vigente, así que hay servicio pagado que no se puede cortar.
     */
    it('no expira si el historial tiene un periodo manual que aún no termina', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente({ periodEnd: MANANA }));

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ expired: 0, skipped: 1 });
      expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
      expect(periodos[0].status).toBe(
        SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
      );
    });

    it('tampoco expira un periodo vigente sin fecha de fin', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente({ periodEnd: null }));

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ expired: 0, skipped: 1 });
      expect(managerUpdate).not.toHaveBeenCalled();
    });
  });

  describe('perfiles gobernados por Stripe', () => {
    it('no los incluye siquiera en la búsqueda de candidatos', async () => {
      perfiles.push(
        perfilManualVencido({
          id: 'profile-stripe',
          billingSource: BILLING_SOURCE_ENUM.STRIPE,
          stripeSubscriptionId: 'sub_1',
        }),
      );

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ candidates: 0, expired: 0 });
      expect(filtroDeCandidatos).toMatchObject({
        billingSource: BILLING_SOURCE_ENUM.MANUAL,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      });
      expect(perfiles[0]).toMatchObject({
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'plus',
        billingSource: BILLING_SOURCE_ENUM.STRIPE,
      });
    });

    /**
     * El caso de carrera del criterio anterior: el perfil era manual al leer la lista y para
     * cuando se lo bloquea ya migró a Stripe (llegó un `invoice.paid` en medio). Manda lo que hay
     * al bloquear, no lo que se leyó.
     */
    it('suelta el candidato que migró a Stripe entre la lectura y el bloqueo', async () => {
      const perfil = perfilManualVencido();
      perfiles.push(perfil);
      periodos.push(periodoManualVigente());

      managerFindOne.mockImplementationOnce(async () => ({
        ...perfil,
        billingSource: BILLING_SOURCE_ENUM.STRIPE,
      }));

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ expired: 0, skipped: 1 });
      expect(managerUpdate).not.toHaveBeenCalled();
    });

    /**
     * Un perfil marcado MANUAL cuyo periodo vivo lo abrió Stripe es una inconsistencia de datos.
     * Cerrar esa fila desde acá rompería la regla de que los periodos de Stripe los gobiernan sus
     * webhooks, así que se avisa y no se toca nada.
     */
    it('no cierra un periodo vigente cuyo origen es STRIPE', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(
        periodoManualVigente({ source: BILLING_SOURCE_ENUM.STRIPE }),
      );

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ expired: 0, skipped: 1 });
      expect(managerUpdate).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia y concurrencia', () => {
    /**
     * Correrlo dos veces tiene que dar el mismo resultado que correrlo una. La segunda pasada ni
     * siquiera encuentra candidatos —el perfil ya es FREE— y, sobre todo, no vuelve a escribir el
     * `ended_at` del historial: esa fecha es el registro de cuándo terminó de verdad el periodo, y
     * reescribirla en cada pasada lo falsearía.
     */
    it('una segunda pasada no cambia nada de lo que dejó la primera', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente());

      await job.run(AHORA);
      const trasLaPrimera = {
        perfil: { ...perfiles[0] },
        periodo: { ...periodos[0] },
      };

      const segunda = await job.run(new Date('2030-06-15T12:05:00.000Z'));

      expect(segunda).toEqual({
        candidates: 0,
        expired: 0,
        skipped: 0,
        failed: 0,
      });
      expect(perfiles[0]).toEqual(trasLaPrimera.perfil);
      expect(periodos[0]).toEqual(trasLaPrimera.periodo);
    });

    /**
     * `FOR UPDATE SKIP LOCKED`: si otra réplica ya tiene el perfil, ésta lo deja pasar en vez de
     * esperar. El trabajo lo hará quien lo tenga bloqueado.
     */
    it('omite el perfil que otra instancia está procesando', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente());
      bloqueadosPorOtraInstancia.add('profile-manual');

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ candidates: 1, expired: 0, skipped: 1 });
      expect(managerUpdate).not.toHaveBeenCalled();
      expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
    });

    it('no arranca una pasada si la anterior sigue corriendo', async () => {
      perfiles.push(perfilManualVencido());
      periodos.push(periodoManualVigente());

      let liberar: () => void = () => undefined;
      const enCurso = new Promise<void>((resolve) => {
        liberar = resolve;
      });
      const runOriginal = job.run.bind(job);
      const spy = jest
        .spyOn(job, 'run')
        .mockImplementationOnce(async (reference) => {
          await enCurso;
          return runOriginal(reference);
        });

      const primera = job.handleCron();
      await job.handleCron();

      expect(spy).toHaveBeenCalledTimes(1);

      liberar();
      await primera;
    });

    /**
     * Una excepción que suba hasta el scheduler no la atiende nadie y en algunas configuraciones
     * tumba el proceso. Se registra y la pasada siguiente reintenta sola.
     */
    it('no propaga el error de una pasada al scheduler', async () => {
      jest.spyOn(job, 'run').mockRejectedValueOnce(new Error('base caída'));

      await expect(job.handleCron()).resolves.toBeUndefined();
    });

    it('queda programado cada cinco minutos', () => {
      const opciones = Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        ExpireManualSubscriptionsJob.prototype.handleCron,
      );

      expect(opciones).toEqual({
        name: EXPIRE_MANUAL_SUBSCRIPTIONS_JOB,
        cronTime: CronExpression.EVERY_5_MINUTES,
      });
    });
  });

  describe('varios perfiles vencidos en la misma pasada', () => {
    beforeEach(() => {
      for (const sufijo of ['a', 'b', 'c']) {
        perfiles.push(perfilManualVencido({ id: `profile-${sufijo}` }));
        periodos.push(
          periodoManualVigente({
            id: `period-${sufijo}`,
            billingProfileId: `profile-${sufijo}`,
          }),
        );
      }
    });

    it('los expira todos', async () => {
      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ candidates: 3, expired: 3, skipped: 0 });
      expect(
        perfiles.every(
          (perfil) => perfil.status === BILLING_PROFILE_STATUS_ENUM.FREE,
        ),
      ).toBe(true);
      expect(
        periodos.every(
          (periodo) =>
            periodo.status === SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
        ),
      ).toBe(true);
    });

    /**
     * Cada perfil va en su propia transacción justamente para esto: uno que falle no puede
     * arrastrar a los demás ni dejar la pasada a medias.
     */
    it('sigue con los demás cuando uno falla', async () => {
      managerFindOne.mockImplementationOnce(async () => {
        throw new Error('conexión perdida');
      });

      const resumen = await job.run(AHORA);

      expect(resumen).toMatchObject({ candidates: 3, expired: 2, failed: 1 });
      expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
      expect(perfiles[1].status).toBe(BILLING_PROFILE_STATUS_ENUM.FREE);
      expect(perfiles[2].status).toBe(BILLING_PROFILE_STATUS_ENUM.FREE);
    });
  });

  /**
   * El perfil dice que venció pero el historial no tiene periodo vigente que lo respalde.
   * Degradar al cliente sin poder explicar después de dónde salió la decisión es peor que dejarle
   * un plan de más, así que se avisa y se deja quieto.
   */
  it('no expira un perfil sin periodo vigente en el historial', async () => {
    perfiles.push(perfilManualVencido());

    const resumen = await job.run(AHORA);

    expect(resumen).toMatchObject({ candidates: 1, expired: 0, skipped: 1 });
    expect(managerUpdate).not.toHaveBeenCalled();
    expect(perfiles[0].status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
  });
});
