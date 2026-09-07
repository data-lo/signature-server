import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PlanEntity } from '../catalog/plan.entity';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_PROFILE_SOURCE_ENUM } from '../enums/billing-profile-source.enum';
import {
  FREE_PLAN_DOCUMENTS_INCLUDED,
  FREE_PLAN_NAME,
  FREE_PLAN_TYPE,
  FREE_WELCOME_DOCUMENT_CREDITS,
} from '../catalog/free-plan.constants';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import { BillingProfileEntity } from './billing-profile.entity';
import type { BillingOwner } from './billing-owner.util';

/**
 * Da de alta el `billing_profile` en plan Free de un propietario recién creado.
 *
 * **Por qué no vive en `BillingOwnerService`, que también crea perfiles:** aquél resuelve al
 * propietario a partir de la cuenta activa de una petición HTTP, y para eso necesita el
 * repositorio de `accounts`. Éste se llama desde el alta de la cuenta, donde el propietario ya
 * es un dato conocido y lo que hace falta es lo contrario: no depender de nada. Por eso la clase
 * **no inyecta nada** y recibe el `EntityManager` del llamador.
 *
 * Ese `EntityManager` es el punto entero del diseño: la fila del perfil se escribe DENTRO de la
 * transacción que está creando la cuenta o la organización, así que o quedan las dos o no queda
 * ninguna. Abrir una transacción propia acá dejaría la puerta a una cuenta sin perfil cuando la
 * de fuera hiciera rollback — que es justo el estado que esta historia viene a eliminar.
 *
 * **Nada de esto habla con Stripe.** El plan Free no tiene producto, precio, cliente ni
 * suscripción en el proveedor: `stripe_customer_id` y `stripe_subscription_id` nacen en `null` y
 * sólo se llenan cuando alguien contrata de verdad (`CreateSubscriptionCheckoutUseCase`). Tampoco
 * se escribe ningún `checkout_order`: no hubo compra.
 *
 * **Sí se escribe un `credit_lot`**, el de bienvenida (`FREE_GRANT`, 3 documentos). Va acá y no
 * en un flujo aparte por lo mismo que el perfil: si se concediera después, una cuenta podría
 * existir con perfil y sin saldo, y su primer documento fallaría por falta de créditos que en
 * realidad le tocaban. Con el alta entera en una transacción, o hay cuenta, perfil y saldo, o no
 * hay nada.
 *
 * Sólo se aprovisiona al PROPIETARIO: la cuenta personal y la organización. Sumarse a una
 * organización que ya existe (invitación aceptada, acceso concedido) no crea perfil, porque el
 * dinero es de la organización y su perfil se creó cuando ella se creó.
 */
@Injectable()
export class BillingProfileProvisioningService {
  private readonly logger = new Logger(BillingProfileProvisioningService.name);

  /**
   * Crea el perfil Free del propietario, o devuelve el que ya tuviera.
   *
   * La idempotencia no es decorativa: este método corre en cada alta, y un propietario con
   * perfil —por un reintento, por una cuenta migrada, o porque el checkout se le adelantó— debe
   * conservar EL SUYO. Sobrescribirlo pondría en `FREE` a quien ya está pagando.
   */
  async provisionFreeProfile(
    manager: EntityManager,
    owner: BillingOwner,
  ): Promise<BillingProfileEntity> {
    const existing = await manager.findOne(BillingProfileEntity, {
      where: owner.organizationId
        ? { organizationId: owner.organizationId }
        : { personalAccountId: owner.personalAccountId },
    });

    if (existing) {
      return existing;
    }

    await this.ensureFreePlanExists(manager);

    const profile = await manager.save(
      manager.create(BillingProfileEntity, {
        personalAccountId: owner.personalAccountId,
        organizationId: owner.organizationId,
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        // Explícito, aunque sea el default de la columna: el alta declara los tres campos que
        // definen el plan gratuito juntos, para que se lean como la afirmación que son.
        billingSource: BILLING_PROFILE_SOURCE_ENUM.FREE,
        // Explícitos, no por omisión: son la afirmación de que el plan Free no toca Stripe.
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
    );

    await this.grantWelcomeCredits(manager, profile.id);

    this.logger.log(
      `Perfil de facturación ${profile.id} creado en plan Free para ${describe(owner)}, ` +
        `con ${FREE_WELCOME_DOCUMENT_CREDITS} documentos de bienvenida.`,
    );

    return profile;
  }

  /**
   * Concede el lote de bienvenida del plan gratuito.
   *
   * **Sólo se llama al CREAR el perfil**, nunca sobre uno que ya existía: el `return existing` de
   * arriba sale antes. Es lo que hace que la bienvenida sea "una sola vez" — si se otorgara en
   * cada paso por este método, un reintento del registro regalaría tres documentos más.
   *
   * El lote nace sin caducidad (`expires_at` nulo) y con la prioridad por omisión (0): son
   * créditos que no se pierden, así que se gastan DESPUÉS de los del periodo facturado, que sí
   * caducan (ver `ConsumeDocumentCreditUseCase`). Tampoco lleva periodo ni factura: no lo emitió
   * ningún cobro.
   */
  private async grantWelcomeCredits(
    manager: EntityManager,
    billingProfileId: string,
  ): Promise<void> {
    await manager.save(
      manager.create(CreditLotEntity, {
        billingProfileId,
        origin: CREDIT_LOT_ORIGIN_ENUM.FREE_GRANT,
        issued: FREE_WELCOME_DOCUMENT_CREDITS,
        remaining: FREE_WELCOME_DOCUMENT_CREDITS,
      }),
    );
  }

  /**
   * Asegura la fila `plans.free` antes de apuntarle.
   *
   * `billing_profiles.current_plan_type` es FK a `plans.plan_type`, así que sin esta fila el
   * alta de CUALQUIER cuenta reventaría con un error de constraint. La migración la siembra,
   * pero el entorno de desarrollo levanta el esquema con `synchronize: true` y sin correr
   * migraciones (ver `app.module.ts`), así que depender sólo de ella dejaría el registro roto en
   * cada base nueva. Mismo criterio que ya siguió la migración del rol MEMBER: sembrar donde
   * hace falta en vez de confiar en que el seed manual se haya corrido.
   *
   * `ON CONFLICT DO NOTHING` y no un `findOne` + `save`: dos altas simultáneas (dos registros a
   * la vez en una base recién creada) pasarían las dos por el `findOne` antes de que ninguna
   * insertara, y la segunda moriría con violación de clave primaria dentro de la transacción del
   * usuario, tumbando su registro.
   */
  private async ensureFreePlanExists(manager: EntityManager): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(PlanEntity)
      .values({
        planType: FREE_PLAN_TYPE,
        name: FREE_PLAN_NAME,
        isActive: true,
        creationSource: PLAN_CREATION_SOURCE_ENUM.MANUAL,
        // Sin producto en Stripe: el plan gratuito no existe allá.
        stripeProductId: null,
        catalogItemId: null,
        documentsIncluded: FREE_PLAN_DOCUMENTS_INCLUDED,
      })
      .orIgnore()
      .execute();
  }
}

function describe(owner: BillingOwner): string {
  return owner.organizationId
    ? `la organización ${owner.organizationId}`
    : `la cuenta personal ${owner.personalAccountId}`;
}
