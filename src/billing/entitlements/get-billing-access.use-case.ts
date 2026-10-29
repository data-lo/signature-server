import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from '../subscriptions/subscription-billing-history.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import type { BillingOwner } from '../profiles/billing-owner.util';
import {
  NO_PLAN_ENTITLEMENTS,
  resolvePlanEntitlements,
} from './plan-entitlements.config';
import type {
  BillingAccessResponse,
  PlanEntitlements,
} from './plan-entitlements.types';

/**
 * Resuelve los beneficios de un propietario a partir del plan de su perfil.
 *
 * Una ORGANIZACIÓN sin plan —sin `billing_profile`, o con un perfil que se abrió al iniciar un
 * Checkout y nunca se pagó— recibe `NO_PLAN_ENTITLEMENTS`, no los del gratuito: las organizaciones
 * nacen sin plan Free y no pueden hacer nada hasta contratar. Las organizaciones que ya existían no
 * cambian: todas tienen perfil con plan (`free` o de pago).
 *
 * Una cuenta personal sin plan conserva el gratuito, y un plan que la tabla comercial no conoce
 * sigue cayendo a Free para cualquiera (ver `resolvePlanEntitlements`).
 *
 * @param owner - Propietario facturable: cuenta personal u organización.
 * @param planType - Plan del perfil, o `null` si no tiene perfil o su perfil no tiene plan.
 * @returns Las acciones y los límites que corresponden.
 *
 * @example
 * ```ts
 * resolveOwnerEntitlements({ personalAccountId: null, organizationId: 'org-1' }, null); // NO_PLAN_ENTITLEMENTS
 * resolveOwnerEntitlements({ personalAccountId: 'acc-1', organizationId: null }, null); // plan free
 * ```
 */
function resolveOwnerEntitlements(
  owner: BillingOwner,
  planType: string | null,
): PlanEntitlements {
  if (owner.organizationId && planType === null) {
    return NO_PLAN_ENTITLEMENTS;
  }

  return resolvePlanEntitlements(planType);
}

/**
 * Construye la respuesta de una cuenta que nunca pasó por facturación.
 *
 * @remarks
 * No es un error ni un 404: toda cuenta existe antes de tener perfil. Los campos del PERFIL van en
 * nulo, porque no hay perfil que describir. `currentPlanType` queda en `null` y no en `'free'`:
 * rellenarlo afirmaría que existe una fila con ese plan.
 *
 * Una cuenta personal sin perfil responde los beneficios del gratuito; una organización sin
 * perfil, ninguno (ver `resolveOwnerEntitlements`).
 *
 * @param owner - Propietario facturable sin `billing_profile`.
 * @returns El estado comercial sin perfil, sin saldo y con los beneficios que le corresponden.
 *
 * @example
 * ```ts
 * accessWithoutProfile({ personalAccountId: null, organizationId: 'org-1' }).actions.signInOrder; // false
 * ```
 */
function accessWithoutProfile(owner: BillingOwner): BillingAccessResponse {
  const { actions, limits } = resolveOwnerEntitlements(owner, null);

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
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable, comprobando que el usuario pertenezca a la cuenta del
 *    header: sin eso, cambiar un valor en la petición dejaría leer el plan y el saldo de una
 *    organización ajena.
 * 2. Busca su `billing_profile`. Si no existe, responde el plan gratuito a una cuenta personal y
 *    ningún acceso a una organización, que nace sin plan.
 * 3. Suma en paralelo el saldo de documentos vigente y el origen del último periodo cobrado.
 * 4. Compone la respuesta resolviendo los beneficios del plan del perfil.
 *
 * **Es la fuente única del frontend, y por eso responde de más.** Antes hacían falta dos consultas
 * al MISMO `billing_profile` que podían dibujarse desfasadas entre sí; aquí el estado, el saldo y
 * lo que se puede hacer con ellos se leen juntos, que es como se usan.
 *
 * **Lo que responde NO autoriza.** `actions` existe para que la pantalla sepa qué dibujar. Cada
 * acción protegida vuelve a validarse en el backend cuando se ejecuta (ver
 * `AssertPlanActionUseCase`), porque un cliente puede mandar la petición sin haber pedido nunca
 * esta respuesta.
 *
 * **No crea el perfil**: es una lectura que se dispara al entrar y al cambiar de cuenta, y dar de
 * alta una fila por cada cuenta que alguien sólo miró ensuciaría `billing_profiles`. El perfil se
 * crea al contratar.
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

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Usuario autenticado y cuenta activa, que juntos deciden por qué propietario
   *   facturable se pregunta.
   * @returns El estado comercial de la cuenta. Sin perfil: el del plan gratuito para una cuenta
   *   personal, y sin plan y con todas las acciones en `false` para una organización.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   */
  async execute(input: {
    userId: string;
    accountId: string;
  }): Promise<BillingAccessResponse> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    if (!profile) {
      return accessWithoutProfile(owner);
    }

    // No dependen entre sí, y este camino se recorre en cada carga del dashboard.
    const [creditsAvailable, billingSource] = await Promise.all([
      this.contarCreditosDisponibles(profile.id),
      this.resolverOrigenDelUltimoCobro(profile.id),
    ]);

    return this.construirRespuesta(
      profile,
      owner,
      creditsAvailable,
      billingSource,
    );
  }

  private construirRespuesta(
    profile: BillingProfileEntity,
    owner: BillingOwner,
    creditsAvailable: number,
    billingSource: BILLING_SOURCE_ENUM | null,
  ): BillingAccessResponse {
    const { actions, limits } = resolveOwnerEntitlements(
      owner,
      profile.currentPlanType,
    );

    return {
      billingProfileId: profile.id,
      // Sólo ACTIVE habilita lo que se paga; los demás estados conservan el plan para nombrarlo.
      hasActiveSubscription:
        profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      currentPlanType: profile.currentPlanType,
      status: profile.status,
      billingSource,
      // No se cruza con `hasActiveSubscription`: una baja programada sigue activa Y no se renueva.
      cancelAtPeriodEnd: profile.cancelAtPeriodEnd,
      currentPeriodStart: profile.currentPeriodStart,
      currentPeriodEnd: profile.currentPeriodEnd,
      creditsAvailable,
      // Salen del plan del PERFIL: un PAST_DUE conserva sus acciones mientras Stripe reintenta.
      actions,
      limits,
    };
  }

  /**
   * Documentos que la cuenta puede consumir HOY.
   *
   * @remarks
   * Suma `remaining` de todos los lotes sin distinguir su origen: para quien va a firmar, un
   * documento del periodo, uno arrastrado y uno comprado suelto valen lo mismo. El origen decide
   * el ORDEN en que se gastan, y eso lo resuelve el consumo.
   *
   * Se filtra por `expires_at` y no por `period_end`: un lote `ROLLOVER` es, por definición, uno
   * cuyo periodo ya terminó y que sigue siendo bueno, así que filtrar por el periodo le borraría
   * al cliente el saldo que se le prometió arrastrar.
   *
   * @param billingProfileId Perfil cuyo saldo se suma.
   * @returns El total utilizable hoy; `0` cuando no hay ningún lote vigente.
   */
  private async contarCreditosDisponibles(
    billingProfileId: string,
  ): Promise<number> {
    const vigente = { billingProfileId, remaining: MoreThan(0) };

    // El arreglo es un OR: `NULL > NOW()` es nulo, no falso, y dejaría fuera los que no caducan.
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
   * @remarks
   * Sale de `subscription_billing_history` y no del perfil, que no lo guarda. Deducirlo de
   * `stripe_subscription_id` sería más barato y estaría mal: un perfil que estuvo en Stripe
   * conserva sus ids aunque hoy se le facture a mano, y contaría como STRIPE justo el caso que
   * hay que distinguir.
   *
   * Se ordena por `period_start` y no por `paid_at`: se busca el periodo más reciente, no el
   * cobro más reciente — una transferencia capturada con retraso tiene `paid_at` posterior al de
   * un periodo que empezó después.
   *
   * @param billingProfileId Perfil cuyo historial se consulta.
   * @returns El origen del último periodo, o `null` si todavía no lo cobró nadie.
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
