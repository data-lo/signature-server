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
 * @remarks
 * No es un error ni un 404: toda cuenta existe antes de tener perfil. Se responde con los
 * beneficios del plan gratuito y los campos del PERFIL en nulo, porque no hay perfil que
 * describir. `currentPlanType` queda en `null` y no en `'free'`: rellenarlo afirmaría que existe
 * una fila con ese plan, y quien necesite saber qué puede hacer ya lo tiene en `actions`.
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
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable, comprobando que el usuario pertenezca a la cuenta del
 *    header: sin eso, cambiar un valor en la petición dejaría leer el plan y el saldo de una
 *    organización ajena.
 * 2. Busca su `billing_profile`. Si no existe, responde el acceso del plan gratuito.
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
   * @returns El estado comercial de la cuenta; para una cuenta sin perfil, el del plan gratuito.
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
      return accesoSinPerfil();
    }

    // No dependen entre sí, y este camino se recorre en cada carga del dashboard.
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
