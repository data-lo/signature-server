import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from '../subscriptions/subscription-billing-history.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { resolvePlanEntitlements } from './plan-entitlements.config';
import type { BillingAccessResponse } from './plan-entitlements.types';

/**
 * Lo que ve una cuenta que nunca pasó por facturación.
 *
 * **No es un error ni un 404**: toda cuenta existe antes de tener perfil, y la pantalla que
 * pregunta es justamente la primera que se dibuja. Se responde con los beneficios del plan
 * gratuito —lo mínimo que cualquiera tiene— y con los campos del PERFIL en nulo, porque no hay
 * perfil que describir. `currentPlanType: null` no se rellena con `'free'` a propósito: sería
 * afirmar que existe una fila con ese plan, y quien necesite saber qué puede hacer ya lo tiene
 * en `actions`, sin deducirlo del nombre del plan.
 */
function accesoSinPerfil(): BillingAccessResponse {
  const { actions, limits } = resolvePlanEntitlements(null);

  return {
    billingProfileId: null,
    hasActiveSubscription: false,
    currentPlanType: null,
    status: null,
    billingSource: null,
    cancelAtPeriodEnd: false,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    creditsAvailable: 0,
    actions,
    limits,
  };
}

/**
 * Estado comercial completo de la cuenta activa: suscripción, saldo, beneficios y límites.
 *
 * **Es la fuente única del frontend, y por eso responde de más.** Antes hacían falta dos
 * consultas —`/payments/subscription` para el estado y `/payments/billing-state` para el plan—
 * que salían del MISMO `billing_profile` y podían dibujarse desfasadas entre sí: dos peticiones,
 * dos cachés, dos momentos. Acá el estado, el saldo y lo que se puede hacer con ellos se leen en
 * una sola respuesta, que es como se usan.
 *
 * **Los beneficios se resuelven del plan, no se consultan.** `PLAN_ENTITLEMENTS` es un mapa
 * estático (ver su docblock), así que este caso de uso no necesita ningún servicio intermedio
 * para leerlo: lo resuelve directo. Cuando los beneficios se negocien por cuenta y dejen de
 * depender sólo del plan, ahí hará falta el servicio; hoy sería una indirección vacía.
 *
 * **Lo que responde NO autoriza.** `actions` existe para que la pantalla sepa qué dibujar,
 * habilitar u ofrecer como mejora. Cada acción protegida vuelve a validarse en el backend contra
 * este mismo mapa cuando se ejecuta (ver `AssertPlanActionUseCase`), porque un cliente puede
 * mandar la petición sin haber pedido nunca esta respuesta.
 *
 * **No crea el perfil.** Es una lectura que se dispara al entrar y al cambiar de cuenta; dar de
 * alta una fila por cada cuenta que alguien sólo miró ensuciaría `billing_profiles` y haría que
 * el caso "sin perfil" no volviera a darse nunca. El perfil se crea al contratar.
 */
@Injectable()
export class GetBillingAccessUseCase {
  constructor(
    private readonly billingOwnerService: BillingOwnerService,
    @InjectRepository(CreditLotEntity)
    private readonly creditLotRepository: Repository<CreditLotEntity>,
    @InjectRepository(SubscriptionBillingHistoryEntity)
    private readonly billingHistoryRepository: Repository<SubscriptionBillingHistoryEntity>,
  ) {}

  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<BillingAccessResponse> {
    /**
     * `resolveOwner` hace dos cosas imprescindibles: comprueba que el usuario pertenezca de
     * verdad a la cuenta del header —sin eso, cambiar un valor en la petición dejaría leer el
     * plan y el saldo de una organización ajena— y traduce la membresía al propietario, que es
     * quien decide si se consulta por `personal_account_id` o por `organization_id`.
     */
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    if (!profile) {
      return accesoSinPerfil();
    }

    /**
     * Las dos consultas que cuelgan del perfil no dependen entre sí, así que van juntas: son la
     * diferencia entre una respuesta y dos idas y vueltas a la base en el camino que el frontend
     * recorre en cada carga del dashboard.
     */
    const [creditsAvailable, billingSource] = await Promise.all([
      this.contarCreditosDisponibles(profile.id),
      this.resolverOrigenDelUltimoCobro(profile.id),
    ]);

    return this.construirRespuesta(profile, creditsAvailable, billingSource);
  }

  private construirRespuesta(
    profile: BillingProfileEntity,
    creditsAvailable: number,
    billingSource: BILLING_SOURCE_ENUM | null,
  ): BillingAccessResponse {
    const { actions, limits } = resolvePlanEntitlements(
      profile.currentPlanType,
    );

    return {
      billingProfileId: profile.id,
      /**
       * Sólo `ACTIVE`. Los demás estados conservan su plan —sigue siendo el último contratado y
       * la pantalla necesita nombrarlo— pero ninguno habilita lo que se paga: `INCOMPLETE` es un
       * checkout sin cobrar, `PAST_DUE` un cobro que falló, `CANCELED` una baja y `FREE` el plan
       * gratuito, que está vigente sin ser una suscripción.
       */
      hasActiveSubscription:
        profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      currentPlanType: profile.currentPlanType,
      status: profile.status,
      billingSource,
      /**
       * No se cruza con `hasActiveSubscription`: son dos preguntas distintas y la pantalla
       * necesita las dos por separado. Una suscripción con la baja programada está activa Y no
       * se renovará, y colapsarlas dejaría al usuario sin saber cuál de las dos está viendo.
       */
      cancelAtPeriodEnd: profile.cancelAtPeriodEnd,
      currentPeriodStart: profile.currentPeriodStart,
      currentPeriodEnd: profile.currentPeriodEnd,
      creditsAvailable,
      /**
       * Los beneficios salen del plan del PERFIL y no de `hasActiveSubscription`. Un perfil en
       * `PAST_DUE` conserva su `premium` y con él sus acciones: cortarle el producto por un
       * cobro que falló —y que Stripe todavía está reintentando— es una decisión comercial que
       * nadie tomó, y tomarla acá de forma implícita la escondería en un booleano.
       */
      actions,
      limits,
    };
  }

  /**
   * Documentos que la cuenta puede consumir HOY.
   *
   * Suma `remaining` de todos los lotes del perfil, sin distinguir su origen: para quien va a
   * firmar, un documento del periodo, uno arrastrado del anterior y uno comprado suelto valen
   * exactamente lo mismo. La distinción existe en `credit_lots.origin` porque determina el ORDEN
   * en que se gastan —eso lo resuelve el consumo, no esta cuenta.
   *
   * **Se filtra por `expires_at` y no por `period_end`**, aunque los dos suenen a caducidad. Un
   * lote `ROLLOVER` es, por definición, uno cuyo periodo YA terminó y que sigue siendo bueno:
   * filtrar por `period_end` le borraría al cliente el saldo que se le prometió arrastrar.
   * `expires_at` es la única fecha que dice de verdad hasta cuándo sirve, y nula significa que
   * no caduca.
   */
  private async contarCreditosDisponibles(
    billingProfileId: string,
  ): Promise<number> {
    const vigente = { billingProfileId, remaining: MoreThan(0) };

    /**
     * Dos condiciones en OR (el arreglo), y no una: "sin caducidad" y "caduca más adelante" son
     * dos filas distintas en SQL —`NULL > NOW()` no es verdadero, es nulo— y expresarlo con un
     * solo `where` dejaría fuera justo los lotes que nunca caducan, que son la mayoría.
     */
    const total = await this.creditLotRepository.sum('remaining', [
      { ...vigente, expiresAt: IsNull() },
      { ...vigente, expiresAt: MoreThan(new Date()) },
    ]);

    /** `null` cuando ninguna fila casa: para el consumidor eso es no tener saldo, que es `0`. */
    return total ?? 0;
  }

  /**
   * Por dónde entró el dinero del último periodo cobrado.
   *
   * **No sale del perfil porque el perfil no lo guarda**: `billing_source` es una columna de
   * `subscription_billing_history`, donde cada periodo declara su origen (ver
   * `BILLING_SOURCE_ENUM`). Deducirlo de `stripe_subscription_id` sería más barato y estaría
   * mal: un perfil que estuvo en Stripe conserva sus ids como referencia histórica aunque hoy se
   * le facture a mano, así que quedaría contando como STRIPE justo el caso que hay que
   * distinguir.
   *
   * `null` cuando no hay ningún periodo cobrado, que es lo que le pasa a toda cuenta gratuita: no
   * es "se desconoce", es que todavía no lo cobró nadie.
   *
   * Se ordena por `period_start` y no por `paid_at` porque lo que se busca es el periodo más
   * reciente, no el cobro más reciente: una transferencia capturada con retraso tiene `paid_at`
   * posterior al de un periodo que empezó después.
   */
  private async resolverOrigenDelUltimoCobro(
    billingProfileId: string,
  ): Promise<BILLING_SOURCE_ENUM | null> {
    const ultimo = await this.billingHistoryRepository.findOne({
      where: { billingProfileId },
      order: { periodStart: 'DESC' },
      select: { id: true, source: true },
    });

    return ultimo?.source ?? null;
  }
}
