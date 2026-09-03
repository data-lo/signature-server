import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { PaymentsModule } from 'src/payments/payments.module';
import { PlanEntity } from './catalog/plan.entity';
import { PlanPriceEntity } from './catalog/plan-price.entity';
import { DocumentPackOfferEntity } from './catalog/document-pack-offer.entity';
import { BillingProfileEntity } from './profiles/billing-profile.entity';
import { CheckoutOrderEntity } from './checkout/checkout-order.entity';
import { CreditLotEntity } from './credits/credit-lot.entity';
import { DocumentCreditConsumptionEntity } from './credits/document-credit-consumption.entity';
import { CatalogSyncService } from './catalog/catalog-sync.service';
import { BillingCatalogService } from './catalog/billing-catalog.service';
import { BillingOwnerService } from './profiles/billing-owner.service';
import { CheckoutOrderService } from './checkout/checkout-order.service';
import { CreateSubscriptionCheckoutUseCase } from './checkout/create-subscription-checkout.use-case';
import { SubscriptionBillingService } from './subscriptions/subscription-billing.service';

/**
 * Dominio de facturación: catálogo comercial, perfiles, órdenes de compra y saldo de documentos.
 *
 * Registra TODAS las entidades del directorio y no sólo las que se inyectan hoy: con
 * `autoLoadEntities: true`, TypeORM carga el metadata de una entidad únicamente si algún
 * `forFeature()` la nombra, y las relaciones entre ellas revientan al construir el grafo si falta
 * alguna, aunque nadie la inyecte.
 *
 * `forwardRef` con `PaymentsModule` porque se necesitan mutuamente: billing usa el adaptador de
 * Stripe para abrir el checkout, y payments usa los handlers de billing desde su router de webhooks.
 * Sacar el adaptador a un tercer módulo es una reorganización mayor de `payments`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlanEntity,
      PlanPriceEntity,
      DocumentPackOfferEntity,
      BillingProfileEntity,
      CheckoutOrderEntity,
      CreditLotEntity,
      DocumentCreditConsumptionEntity,
      // Sólo para comprobar la membresía de la cuenta activa (ver `BillingOwnerService`);
      // este módulo nunca escribe en `accounts`.
      AccountEntity,
    ]),
    forwardRef(() => PaymentsModule),
  ],
  providers: [
    CatalogSyncService,
    BillingCatalogService,
    BillingOwnerService,
    CheckoutOrderService,
    CreateSubscriptionCheckoutUseCase,
    SubscriptionBillingService,
  ],
  exports: [
    CatalogSyncService,
    BillingCatalogService,
    BillingOwnerService,
    CheckoutOrderService,
    CreateSubscriptionCheckoutUseCase,
    SubscriptionBillingService,
  ],
})
export class BillingModule {}
