import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { PaymentsModule } from 'src/payments/payments.module';
import { PlanEntity } from './catalog/plan.entity';
import { CatalogItemEntity } from './catalog/catalog-item.entity';
import { CatalogPriceEntity } from './catalog/catalog-price.entity';
import { CatalogItemScopeEntity } from './catalog/catalog-item-scope.entity';
import { DocumentCreditPackEntity } from './catalog/document-credit-pack.entity';
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
 * Registra TODAS las entidades del directorio y no sólo las que hoy se inyectan porque con
 * `autoLoadEntities: true` (ver `app.module.ts`) TypeORM únicamente carga el metadata de una
 * entidad si algún `forFeature()` la nombra — que exista su archivo `.entity.ts` no basta. Las
 * relaciones entre ellas (`checkout_orders → catalog_prices`, `credit_lots ← checkout_orders`,
 * `catalog_items → plans/document_credit_packs`) revientan al construir el grafo si alguna falta,
 * aunque nadie la inyecte.
 *
 * `forwardRef` con `PaymentsModule`: ambos se necesitan mutuamente. Billing usa el adaptador de
 * Stripe (`StripePaymentService`) para abrir el checkout, y payments usa los handlers de
 * billing desde su router de webhooks. La alternativa —sacar el adaptador a un tercer módulo— es
 * una reorganización mayor de `payments` que no toca a esta historia.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlanEntity,
      CatalogItemEntity,
      CatalogPriceEntity,
      CatalogItemScopeEntity,
      DocumentCreditPackEntity,
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
