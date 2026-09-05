import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { BILLING_PERIOD_END_REASON_ENUM } from '../enums/billing-period-end-reason.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';

/** Nombre registrado en el scheduler; permite pausarlo o dispararlo desde `SchedulerRegistry`. */
export const EXPIRE_MANUAL_SUBSCRIPTIONS_JOB = 'expire-manual-subscriptions';

/**
 * Techo de perfiles por ejecución.
 *
 * No es una optimización sino un límite de daño: si un error de datos dejara diez mil perfiles
 * manuales vencidos a la vez, sin tope este job abriría diez mil transacciones seguidas y
 * competiría con el tráfico real por las conexiones. Lo que no entra en una pasada entra en la
 * siguiente cinco minutos después, y el `ORDER BY current_period_end ASC` garantiza que se
 * atiende primero a quien lleva más tiempo vencido.
 */
const MAX_PROFILES_PER_RUN = 500;

/** Lo que hizo una pasada; se devuelve para poder afirmarlo en las pruebas y registrarlo. */
export interface ExpireManualSubscriptionsSummary {
  candidates: number;
  expired: number;
  skipped: number;
  failed: number;
}

/**
 * Devuelve a plan Free los perfiles de **facturación manual** cuyo periodo ya terminó.
 *
 * **Por qué existe.** Una suscripción de Stripe se apaga sola: el proveedor deja de cobrar y
 * manda `customer.subscription.deleted`, que `SubscriptionBillingService` ya atiende. Una
 * facturación manual no tiene proveedor que avise, así que sin este job un plan pagado por un
 * mes seguiría vigente para siempre. Éste es el equivalente local de aquel webhook.
 *
 * **Nunca toca un perfil `STRIPE`, y no es una precaución sino la regla central.** El ciclo de
 * vida de esos perfiles lo gobiernan los webhooks; si el cron también opinara, un retraso de
 * Stripe en avisar de una renovación bastaría para que este job viera un `current_period_end`
 * pasado y degradara a Free a alguien que acaba de pagar. La condición `billing_source = MANUAL`
 * de la consulta es lo que lo impide, y se vuelve a comprobar después de bloquear la fila.
 *
 * **Idempotente y seguro con varias instancias.** Tres mecanismos, cada uno para un riesgo
 * distinto:
 *
 * 1. `FOR UPDATE SKIP LOCKED` al bloquear el perfil: dos réplicas que corran a la vez se
 *    reparten los perfiles en vez de bloquearse mutuamente, y ninguna espera a la otra.
 * 2. Se REVALIDAN las condiciones ya con el bloqueo puesto. La lista de candidatos se lee sin
 *    bloqueo —leerla bloqueando sería tener toda la tabla tomada durante la pasada entera—, así
 *    que entre la lectura y el bloqueo el perfil pudo renovarse o vencerse en otra instancia.
 *    Lo que decide no es lo que se leyó, es lo que hay al bloquear.
 * 3. `this.running`, contra el solapamiento del propio scheduler: una pasada que tarde más de
 *    cinco minutos no debe encontrarse a sí misma. (Sólo cubre este proceso; entre réplicas
 *    manda el punto 1.)
 *
 * **No borra ni modifica nada más.** `credit_lots`, `checkout_orders`, el historial anterior y
 * los ids de Stripe que el perfil conserve quedan intactos: son la prueba de lo que el cliente
 * pagó y consumió, y perder el plan no le quita lo que ya compró.
 */
@Injectable()
export class ExpireManualSubscriptionsJob {
  private readonly logger = new Logger(ExpireManualSubscriptionsJob.name);

  /** Ver el punto 3 del docblock: evita que el scheduler solape dos pasadas en este proceso. */
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
  ) {}

  /**
   * Cada cinco minutos: lo bastante fino para que nadie conserve un plan vencido más de ese rato,
   * y lo bastante espaciado para que una pasada normal —que casi siempre encuentra cero
   * candidatos y se va en una consulta indexada— no pese nada.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: EXPIRE_MANUAL_SUBSCRIPTIONS_JOB,
  })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'La pasada anterior sigue corriendo; se omite este disparo.',
      );
      return;
    }

    this.running = true;
    try {
      await this.run();
    } catch (error) {
      /**
       * El error se traga a propósito: una excepción que suba hasta el scheduler no la atiende
       * nadie —no hay petición ni reintento detrás— y en algunas configuraciones tumba el
       * proceso. Queda registrada, y la pasada siguiente reintenta sola dentro de cinco minutos
       * porque los candidatos se recalculan cada vez.
       */
      this.logger.error(
        `La expiración de suscripciones manuales falló: ${describeError(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Una pasada completa. Público y con el instante inyectable para poder ejercitarlo en pruebas
   * sin depender del reloj ni del scheduler.
   */
  async run(
    reference: Date = new Date(),
  ): Promise<ExpireManualSubscriptionsSummary> {
    const candidates = await this.billingProfileRepository.find({
      where: {
        billingSource: BILLING_SOURCE_ENUM.MANUAL,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodEnd: LessThanOrEqual(reference),
      },
      select: { id: true },
      order: { currentPeriodEnd: 'ASC' },
      take: MAX_PROFILES_PER_RUN,
    });

    const summary: ExpireManualSubscriptionsSummary = {
      candidates: candidates.length,
      expired: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const expired = await this.expireProfile(candidate.id, reference);
        if (expired) {
          summary.expired += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        /**
         * Un perfil que falla no puede llevarse a los demás: cada uno va en su propia
         * transacción justamente para eso. Se cuenta, se registra y la pasada sigue; el
         * siguiente disparo lo reintentará porque sus condiciones no han cambiado.
         */
        summary.failed += 1;
        this.logger.error(
          `No se pudo expirar el perfil ${candidate.id}: ${describeError(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    if (summary.candidates > 0) {
      this.logger.log(
        `Expiración manual: ${summary.candidates} candidato(s), ${summary.expired} expirado(s), ` +
          `${summary.skipped} omitido(s), ${summary.failed} con error.`,
      );
    }

    return summary;
  }

  /** `true` si el perfil quedó en Free; `false` si se decidió no tocarlo. */
  private async expireProfile(
    billingProfileId: string,
    reference: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const profile = await manager.findOne(BillingProfileEntity, {
        where: { id: billingProfileId },
        /**
         * `skip_locked` en vez de esperar: si otra instancia ya tiene este perfil, el trabajo
         * está hecho o se está haciendo, y quedarse esperando sólo alargaría la pasada para
         * acabar encontrando las condiciones ya incumplidas. Se devuelve `null` y seguimos.
         */
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });

      if (!profile) {
        return false;
      }

      if (!this.isExpiredManualProfile(profile, reference)) {
        return false;
      }

      const historyRepository = manager.getRepository(
        SubscriptionBillingHistoryEntity,
      );

      const activePeriod = await historyRepository.findOne({
        where: {
          billingProfileId: profile.id,
          status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
        },
      });

      if (!this.canCloseActivePeriod(profile.id, activePeriod, reference)) {
        return false;
      }

      if (activePeriod) {
        await this.closePeriod(manager, activePeriod.id, reference);
      }

      /**
       * `current_period_end` NO se anula: es la respuesta a "¿hasta cuándo tuvo plan?" y lo que
       * permite ofrecerle una renovación. `current_period_start` sí, porque un periodo terminado
       * no tiene inicio vigente. Nada más de la fila se toca — los ids de Stripe históricos se
       * quedan donde están.
       */
      await manager.update(BillingProfileEntity, profile.id, {
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        billingSource: BILLING_SOURCE_ENUM.FREE,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
      });

      this.logger.log(
        `Perfil ${profile.id} devuelto a plan Free: su periodo manual terminó el ` +
          `${profile.currentPeriodEnd?.toISOString()}.`,
      );

      return true;
    });
  }

  /**
   * Repite con el bloqueo puesto exactamente lo que filtró la consulta de candidatos.
   *
   * No es redundante: entre leer la lista y bloquear la fila pudo pasar cualquier cosa —una
   * renovación manual que empujó el periodo hacia adelante, una migración a Stripe, otra
   * instancia que ya la expiró—. Éste es el único momento en que lo que se lee es lo que se va a
   * escribir.
   */
  private isExpiredManualProfile(
    profile: BillingProfileEntity,
    reference: Date,
  ): boolean {
    if (profile.billingSource !== BILLING_SOURCE_ENUM.MANUAL) {
      return false;
    }

    if (profile.status !== BILLING_PROFILE_STATUS_ENUM.ACTIVE) {
      return false;
    }

    return (
      profile.currentPeriodEnd !== null &&
      profile.currentPeriodEnd.getTime() <= reference.getTime()
    );
  }

  /**
   * Decide si el periodo vigente del historial es de verdad uno terminado que toque cerrar.
   *
   * Los tres casos que dicen que no:
   *
   * - **No hay periodo vigente.** El historial no respalda la expiración. Se avisa y no se toca
   *   nada: degradar al cliente apoyándose en un perfil cuyo historial no dice lo mismo es
   *   quitarle servicio sin poder explicar después por qué.
   * - **El periodo vigente no es manual.** Un perfil marcado `MANUAL` cuyo periodo vivo lo abrió
   *   Stripe es una inconsistencia, y cerrar una fila de Stripe desde acá rompería la regla de
   *   que sus periodos los gobiernan sus webhooks.
   * - **El periodo vigente sigue corriendo** (`period_end` futuro o sin fecha). Es el caso que
   *   pide la historia: si un administrador renovó antes de que venciera el anterior, el perfil
   *   NO debe volver a Free. Sin fecha tampoco se vence — no hay nada que demuestre que terminó.
   */
  private canCloseActivePeriod(
    billingProfileId: string,
    activePeriod: SubscriptionBillingHistoryEntity | null,
    reference: Date,
  ): boolean {
    if (!activePeriod) {
      this.logger.warn(
        `El perfil ${billingProfileId} está vencido pero no tiene periodo vigente en el ` +
          'historial; no se expira hasta que los datos coincidan.',
      );
      return false;
    }

    if (activePeriod.source !== BILLING_SOURCE_ENUM.MANUAL) {
      this.logger.warn(
        `El perfil ${billingProfileId} es MANUAL pero su periodo vigente ` +
          `${activePeriod.id} es ${activePeriod.source}; no se expira.`,
      );
      return false;
    }

    if (
      activePeriod.periodEnd === null ||
      activePeriod.periodEnd.getTime() > reference.getTime()
    ) {
      this.logger.log(
        `El perfil ${billingProfileId} tiene un periodo manual vigente ` +
          `(${activePeriod.id}); se renovó antes de vencer y no se expira.`,
      );
      return false;
    }

    return true;
  }

  /**
   * Cierra la fila del historial condicionando el `UPDATE` a que siga `ACTIVE`.
   *
   * La condición es lo que hace idempotente el cierre: aunque dos caminos llegaran hasta aquí
   * con la misma fila, el segundo afecta a cero filas en vez de pisar el `ended_at` y el
   * `ended_reason` que escribió el primero — que son el registro de CUÁNDO y POR QUÉ terminó, y
   * reescribirlos falsearía el historial.
   */
  private async closePeriod(
    manager: EntityManager,
    periodId: string,
    reference: Date,
  ): Promise<void> {
    await manager.update(
      SubscriptionBillingHistoryEntity,
      {
        id: periodId,
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
      },
      {
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
        endedAt: reference,
        endedReason: BILLING_PERIOD_END_REASON_ENUM.MANUAL_PERIOD_ENDED,
      },
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
