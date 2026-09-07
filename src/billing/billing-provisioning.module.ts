import { Module } from '@nestjs/common';
import { BillingProfileProvisioningService } from './profiles/billing-profile-provisioning.service';

/**
 * Lo mínimo de facturación que necesita el alta de una cuenta, en un módulo aparte del resto.
 *
 * Existe para no importar `BillingModule` desde `AccountModule`. Aquél arrastra el adaptador de
 * Stripe, el catálogo, Redis y las órdenes de compra: registrar un usuario acabaría instanciando
 * el cliente de un proveedor de pagos con el que este flujo no habla, y ataría el registro a que
 * esa configuración exista. Es el mismo criterio, en espejo, por el que `BillingOwnerService`
 * consulta `accounts` en vez de importar `AccountModule` (ver su docblock).
 *
 * `BillingProfileProvisioningService` no inyecta nada —trabaja con el `EntityManager` que le
 * pasa el llamador— así que este módulo no necesita ni `TypeOrmModule.forFeature`: las entidades
 * que toca ya tienen metadata registrada por `BillingModule`.
 */
@Module({
  providers: [BillingProfileProvisioningService],
  exports: [BillingProfileProvisioningService],
})
export class BillingProvisioningModule {}
