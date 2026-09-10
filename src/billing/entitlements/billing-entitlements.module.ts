import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { SubscriptionBillingHistoryEntity } from '../subscriptions/subscription-billing-history.entity';
import { GetBillingAccessUseCase } from './get-billing-access.use-case';
import { AssertPlanActionUseCase } from './assert-plan-action.use-case';

/**
 * Lo que hace falta para preguntar **qué puede hacer** una cuenta, sin nada de cobrar.
 *
 * Existe por el mismo motivo que `BillingProvisioningModule`, que ya separó el alta del perfil
 * Free: `BillingModule` arrastra el adaptador de Stripe, el catálogo, Redis y las órdenes de
 * compra, y cualquier módulo que sólo quiera autorizar una acción —crear una organización, por
 * ejemplo— acabaría instanciando un cliente de pagos con el que ese flujo no habla, y atándose a
 * que su configuración exista. Acá dentro no hay proveedor de pagos: se leen `billing_profiles`,
 * `credit_lots` y el historial, y se resuelve la tabla comercial que vive en código.
 *
 * `BillingOwnerService` se define **aquí y sólo aquí**, y `BillingModule` lo recibe importando
 * este módulo. Registrarlo en los dos daría dos instancias del mismo servicio —inofensivo hoy,
 * porque no guarda estado, y una trampa el día que guarde algo (una caché de perfiles, un
 * contador). Una definición, dos consumidores.
 *
 * Las entidades se declaran otra vez en `forFeature` aunque `BillingModule` ya las nombre: eso
 * registra el repositorio en ESTE inyector, y sin ello los proveedores de acá no podrían
 * inyectarlo cuando el módulo se importa desde fuera de billing.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BillingProfileEntity,
      CreditLotEntity,
      SubscriptionBillingHistoryEntity,
      // Sólo para comprobar la membresía de la cuenta activa (ver `BillingOwnerService`);
      // este módulo nunca escribe en `accounts`.
      AccountEntity,
    ]),
  ],
  providers: [
    BillingOwnerService,
    GetBillingAccessUseCase,
    AssertPlanActionUseCase,
  ],
  exports: [BillingOwnerService, GetBillingAccessUseCase, AssertPlanActionUseCase],
})
export class BillingEntitlementsModule {}
