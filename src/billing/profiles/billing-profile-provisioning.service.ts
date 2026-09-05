import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PlanEntity } from '../catalog/plan.entity';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  FREE_PLAN_DOCUMENTS_INCLUDED,
  FREE_PLAN_NAME,
  FREE_PLAN_TYPE,
} from '../catalog/free-plan.constants';
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
 * se escribe ningún `checkout_order` —no hubo compra— ni ningún `credit_lot`: los créditos del
 * plan gratuito son de su propio flujo de asignación.
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
        // Explícitos, no por omisión: son la afirmación de que el plan Free no toca Stripe.
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
    );

    this.logger.log(
      `Perfil de facturación ${profile.id} creado en plan Free para ${describe(owner)}.`,
    );

    return profile;
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
