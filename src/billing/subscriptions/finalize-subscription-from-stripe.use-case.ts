import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Stripe = require('stripe');
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { SubscriptionBillingHistoryEntity } from './subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { SUBSCRIPTION_END_REASON_ENUM } from '../enums/subscription-end-reason.enum';
import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';

/**
 * Qué se encontró al intentar cerrar el periodo.
 *
 * `SIN_PERIODO` no es un error: una suscripción anterior a que existiera
 * `subscription_billing_history`, o una cuyo `invoice.paid` nunca llegó, no tiene renglón que
 * cerrar. El perfil se devuelve al plan gratuito igualmente —lo que el cliente ve es eso— y el
 * aviso queda en el log para quien tenga que reconstruir el periodo a mano.
 */
type ResultadoDelCierre = 'CERRADO' | 'YA_CERRADO' | 'SIN_PERIODO';

/** Cómo terminó la suscripción: la categoría con la que se cuenta y el motivo concreto. */
interface Termino {
  status:
    | SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED
    | SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED;
  reason: SUBSCRIPTION_END_REASON_ENUM;
}

/**
 * Cierra definitivamente una suscripción que Stripe ya dio de baja: registra el término en el
 * historial y devuelve el perfil al plan gratuito.
 *
 * **Es la confirmación final, no la intención.** Una suscripción con `cancel_at_period_end = true`
 * sigue `ACTIVE` y conserva todos sus beneficios hasta que el periodo pagado se agota; lo que
 * cierra el ciclo es este evento y sólo éste. Hacerlo antes le quitaría al cliente tiempo que ya
 * compró.
 *
 * **El perfil vuelve a `FREE`, no a `CANCELED`.** Es un cambio de criterio respecto de cómo se
 * hacía: antes el estado era el único sitio donde constaba que alguien había contratado y se
 * había ido, así que había que reservarle un valor. Ahora eso lo guarda
 * `subscription_billing_history` —con el plan, las fechas y el motivo— y el perfil puede decir lo
 * único que le toca decir: qué tiene el cliente HOY, que es el plan gratuito. Ver el docblock de
 * `BILLING_PROFILE_STATUS_ENUM`.
 *
 * **Nada de lo comprado se toca.** `credit_lots`, `checkout_orders`, los renglones anteriores del
 * historial y los identificadores de Stripe quedan intactos: son la evidencia de lo que el cliente
 * pagó y consumió, y hacen falta para responder una aclaración meses después de la baja.
 *
 * **No abre periodos, sólo los cierra.** Los renglones del historial los crea
 * `RegisterSubscriptionBillingUseCase` cuando hay un cobro de verdad —con su importe, su fecha de
 * pago y su factura—, y una baja no aporta ninguna de las tres cosas. Acá se marca el último
 * periodo cobrado de la suscripción con cómo, cuándo y por qué terminó.
 *
 * **Idempotente porque Stripe reintenta.** El mismo evento puede llegar varias veces, y también
 * puede llegar detrás de un `customer.subscription.updated` que ya describía el mismo final. La
 * reconciliación va por `stripe_subscription_id`: si esa suscripción ya tiene su renglón cerrado,
 * la operación termina sin escribir nada y sin fallar.
 */
@Injectable()
export class FinalizeSubscriptionFromStripeUseCase {
  private readonly logger = new Logger(
    FinalizeSubscriptionFromStripeUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
  ) {}

  async execute(subscription: Stripe.Subscription): Promise<void> {
    const stripeCustomerId = this.toId(subscription.customer);

    const profile = await this.findProfile(subscription.id, stripeCustomerId);

    /**
     * **Se avisa y se devuelve 2xx en vez de fallar.** Un 5xx haría que Stripe reintentara la
     * entrega durante días, y ninguno de esos reintentos encontraría el perfil: si no está
     * vinculado ni por suscripción ni por cliente, el vínculo no aparece solo. Lo que arregla el
     * caso es una intervención humana, y para eso el aviso lleva los tres datos con los que
     * buscar en Stripe y en la base.
     */
    if (!profile) {
      this.logger.warn(
        'customer.subscription.deleted sin perfil de facturación asociado; no se finaliza nada. ' +
          `suscripción=${subscription.id} cliente=${stripeCustomerId ?? '(sin id)'} ` +
          `estado=${subscription.status}`,
      );
      return;
    }

    const termino = this.clasificarTermino(subscription);

    await this.dataSource.transaction(async (manager) => {
      /**
       * El perfil se relee bloqueado dentro de la transacción: entre la búsqueda de arriba —que
       * corre sin bloqueo para no retener la fila mientras se decide si hay algo que hacer— y
       * este punto, otra entrega del mismo evento pudo haberlo finalizado ya.
       */
      const locked = await manager.findOne(BillingProfileEntity, {
        where: { id: profile.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked) {
        return;
      }

      const cierre = await this.closeHistory(
        manager,
        locked,
        subscription,
        termino,
      );

      if (cierre === 'YA_CERRADO') {
        this.logger.log(
          `La suscripción ${subscription.id} ya estaba finalizada en el perfil ${locked.id}; ` +
            'no se repite nada.',
        );
        return;
      }

      /**
       * Sin renglón que cerrar, la degradación sigue siendo lo correcto —el cliente dejó de
       * pagar y no puede quedarse con el plan—, pero entonces hace falta otra forma de reconocer
       * una entrega repetida: un perfil ya en el plan gratuito no tiene nada que degradar, y
       * repetirlo sólo escribiría dos veces lo mismo.
       */
      if (cierre === 'SIN_PERIODO') {
        this.logger.warn(
          `La suscripción ${subscription.id} no tiene periodo registrado en el perfil ` +
            `${locked.id}; se devuelve el perfil al plan gratuito sin cerrar historial. ` +
            'El periodo tendrá que reconstruirse a mano si hace falta para un corte de caja.',
        );

        if (this.yaEstaEnFree(locked)) {
          return;
        }
      }

      await this.downgradeToFree(manager, locked);

      this.logger.log(
        `Perfil ${locked.id} devuelto al plan gratuito tras terminar la suscripción ` +
          `${subscription.id} (${termino.reason}).`,
      );
    });
  }

  /**
   * Marca el periodo cobrado con cómo, cuándo y por qué terminó la suscripción.
   *
   * **Sólo actualiza; nunca inserta.** Un renglón del historial representa un cobro —lleva
   * importe, fecha de pago y la factura que lo respalda, y la base lo exige
   * (`CHK_subscription_billing_history_origin_evidence`)—, y una baja no aporta ninguno de los
   * tres. Abrir acá una fila para registrar el final significaría inventarse un cobro que no
   * existió.
   */
  private async closeHistory(
    manager: EntityManager,
    profile: BillingProfileEntity,
    subscription: Stripe.Subscription,
    termino: Termino,
  ): Promise<ResultadoDelCierre> {
    const historyRepository = manager.getRepository(
      SubscriptionBillingHistoryEntity,
    );

    /**
     * El ÚLTIMO periodo de ESTA suscripción, que es el que la tenía viva cuando Stripe la dio de
     * baja. Se busca por suscripción y no sólo por perfil porque un cliente que contrata, se va y
     * vuelve tiene renglones de varias suscripciones en el mismo perfil, y cerrar "el último del
     * perfil" acabaría marcando el periodo vigente de la suscripción NUEVA con la baja de la
     * vieja. El orden es por `period_start` —el comercial, el del índice— y `created_at` sólo
     * desempata cuando dos renglones cubren el mismo periodo.
     */
    const ultimoPeriodo = await historyRepository.findOne({
      where: {
        billingProfileId: profile.id,
        stripeSubscriptionId: subscription.id,
      },
      order: { periodStart: 'DESC', createdAt: 'DESC' },
    });

    if (!ultimoPeriodo) {
      return 'SIN_PERIODO';
    }

    if (
      ultimoPeriodo.status !== SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE
    ) {
      return 'YA_CERRADO';
    }

    /**
     * Condicionado a que siga `ACTIVE`: si dos entregas simultáneas llegaran hasta acá, la
     * segunda afecta a cero filas en vez de pisar el `ended_at` que escribió la primera —que es
     * el registro de cuándo terminó de verdad, y reescribirlo falsearía el historial.
     */
    const result = await manager.update(
      SubscriptionBillingHistoryEntity,
      {
        id: ultimoPeriodo.id,
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
      },
      {
        status: termino.status,
        endedAt: this.resolveEndedAt(subscription),
        endedReason: termino.reason,
      },
    );

    return result.affected ? 'CERRADO' : 'YA_CERRADO';
  }

  /**
   * Un perfil que ya está en el plan gratuito por esta misma baja no tiene nada que degradar.
   * Es la comprobación de repetición para las suscripciones sin periodo registrado, donde el
   * historial no puede hacer de testigo.
   */
  private yaEstaEnFree(profile: BillingProfileEntity): boolean {
    return (
      profile.status === BILLING_PROFILE_STATUS_ENUM.FREE &&
      profile.currentPlanType === FREE_PLAN_TYPE
    );
  }

  /**
   * Devuelve el perfil al plan gratuito conservando todo lo que sirve para auditar.
   *
   * Lo que se conserva no es descuido: `stripe_customer_id` es el mismo cliente para siempre y
   * volverá a usarse si contrata otra vez; `stripe_subscription_id` es la referencia con la que se
   * localiza este ciclo en el panel del proveedor; y `current_period_end` responde "¿hasta cuándo
   * tuvo servicio?". Lo único que se anula es `current_period_start`, porque no hay periodo en
   * curso que declarar.
   */
  private async downgradeToFree(
    manager: EntityManager,
    profile: BillingProfileEntity,
  ): Promise<void> {
    await manager.update(BillingProfileEntity, profile.id, {
      currentPlanType: FREE_PLAN_TYPE,
      status: BILLING_PROFILE_STATUS_ENUM.FREE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: null,
    });
  }

  /**
   * Traduce el porqué de Stripe al nuestro.
   *
   * El vocabulario del proveedor (`cancellation_details.reason`) es
   * `cancellation_requested | payment_failed | payment_disputed | canceled_by_retention_policy`,
   * y se colapsa en los tres motivos que el negocio distingue:
   *
   * ```
   * payment_failed                → PAYMENT_FAILURE         (EXPIRED)
   * cancellation_requested        → CANCELED_AT_PERIOD_END  (CANCELED)
   * payment_disputed              → STRIPE_TERMINATED       (CANCELED)
   * canceled_by_retention_policy  → STRIPE_TERMINATED       (CANCELED)
   * ```
   *
   * `cancel_at_period_end` entra como respaldo del segundo caso, para las bajas anteriores a que
   * Stripe informara este detalle: ahí la bandera es la única evidencia de que se había pedido.
   *
   * **Sólo el impago cuenta como `EXPIRED`**, porque es el único término que el cliente no
   * eligió. Una disputa también acaba en baja, pero la inició él; meterla en el mismo saco que un
   * cobro rechazado por fondos insuficientes mezclaría a quien hay que recuperar con quien hay
   * que atender.
   */
  private clasificarTermino(subscription: Stripe.Subscription): Termino {
    const motivoDeStripe = subscription.cancellation_details?.reason;

    if (motivoDeStripe === 'payment_failed') {
      return {
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.EXPIRED,
        reason: SUBSCRIPTION_END_REASON_ENUM.PAYMENT_FAILURE,
      };
    }

    if (
      motivoDeStripe === 'cancellation_requested' ||
      subscription.cancel_at_period_end
    ) {
      return {
        status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
        reason: SUBSCRIPTION_END_REASON_ENUM.CANCELED_AT_PERIOD_END,
      };
    }

    return {
      status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.CANCELED,
      reason: SUBSCRIPTION_END_REASON_ENUM.STRIPE_TERMINATED,
    };
  }

  /**
   * Cuándo terminó de verdad.
   *
   * `ended_at` es lo que Stripe afirma; `canceled_at` cubre las bajas inmediatas, donde el fin y
   * la solicitud coinciden. La caída a "ahora" no es un adorno: sin fecha, el `CHECK` de la tabla
   * rechazaría el cierre y el webhook fallaría en bucle por un dato que el proveedor no mandó.
   */
  private resolveEndedAt(subscription: Stripe.Subscription): Date {
    return (
      this.toDate(subscription.ended_at) ??
      this.toDate(subscription.canceled_at) ??
      new Date()
    );
  }

  /**
   * Busca primero por suscripción y cae al cliente si no la encuentra.
   *
   * El respaldo importa incluso en la baja: un perfil cuyo `stripe_subscription_id` nunca llegó a
   * grabarse —el `checkout.session.completed` se perdió— sigue teniendo su `stripe_customer_id`,
   * que se escribe antes de abrir el checkout. Sin el respaldo, ese cliente se quedaría con un
   * plan de pago que Stripe ya no cobra.
   */
  private async findProfile(
    stripeSubscriptionId: string,
    stripeCustomerId: string | null,
  ): Promise<BillingProfileEntity | null> {
    const bySubscription = await this.billingProfileRepository.findOne({
      where: { stripeSubscriptionId },
    });

    if (bySubscription) {
      return bySubscription;
    }

    if (stripeCustomerId) {
      return this.billingProfileRepository.findOne({
        where: { stripeCustomerId },
      });
    }

    return null;
  }

  /** Stripe entrega segundos desde epoch; `Date` espera milisegundos. */
  private toDate(seconds: number | null | undefined): Date | null {
    return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
  }

  /** Un campo de Stripe llega como id suelto o como el objeto expandido, según la petición. */
  private toId(
    value: string | { id: string } | null | undefined,
  ): string | null {
    if (!value) {
      return null;
    }

    return typeof value === 'string' ? value : value.id;
  }
}
