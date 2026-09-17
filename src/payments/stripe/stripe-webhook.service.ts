import { Injectable, Logger } from '@nestjs/common';
import Stripe = require('stripe');
import { CatalogSyncService } from '../../billing/catalog/catalog-sync.service';
import { StripePaymentService } from './stripe-payment.service';
import { SubscriptionBillingService } from '../../billing/subscriptions/subscription-billing.service';
import { RegisterDocumentCreditPurchaseUseCase } from '../../billing/credits/register-document-credit-purchase.use-case';

/**
 * Router de los eventos de Stripe ya autenticados. Cada evento soportado tiene su propio handler
 * — para reaccionar a uno nuevo basta con agregar un case al switch de `process()`.
 *
 * Los efectos sobre suscripciones y saldo viven en `billing` (`billing_profiles` +
 * `credit_lots`), y los del catálogo en `CatalogSyncService`. Hasta la depuración de modelos
 * deprecados también se mantenía aquí `account_subscriptions`, el modelo anterior de
 * suscripción: ya nada lo leía y se eliminó junto con su tabla.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly catalogSyncService: CatalogSyncService,
    private readonly paymentGateway: StripePaymentService,
    private readonly subscriptionBillingService: SubscriptionBillingService,
    private readonly registerDocumentCreditPurchase: RegisterDocumentCreditPurchaseUseCase,
  ) {}

  async process(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.subscriptionBillingService.handleCheckoutSessionCompleted(
          session,
        );
        /**
         * Las compras sueltas de documentos llegan por el MISMO evento, en modo `payment`. Cada
         * manejador filtra por `session.mode` y atiende lo suyo: aquél las suscripciones, éste
         * los créditos. Van los dos y no un `else` porque el evento es el mismo canal para dos
         * flujos que no se conocen entre sí.
         */
        await this.registerDocumentCreditPurchase.handleCheckoutSessionCompleted(
          session,
        );
        break;
      }
      case 'invoice.paid':
        await this.subscriptionBillingService.handleInvoicePaid(
          event.data.object as Stripe.Invoice,
        );
        break;
      case 'invoice.payment_failed':
        await this.subscriptionBillingService.handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice,
        );
        break;
      case 'customer.subscription.updated':
        await this.subscriptionBillingService.handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;
      case 'customer.subscription.deleted':
        await this.subscriptionBillingService.handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;
      case 'product.created':
      case 'product.updated': {
        const product = event.data.object as Stripe.Product;
        this.logger.log(
          `Webhook ${event.type} recibido para el producto ${product.id} (${product.name}).`,
        );
        await this.catalogSyncService.syncProductUpserted(product);
        this.logger.log(
          `Producto ${product.id} sincronizado tras ${event.type}.`,
        );
        break;
      }
      case 'product.deleted':
        await this.catalogSyncService.syncProductDeleted(
          event.data.object as Stripe.Product,
        );
        break;
      /**
       * `price.created` y `price.updated` mantienen `catalog_prices` y aseguran el detalle del
       * ítem (plan o paquete de créditos) antes de registrar la oferta.
       *
       * `plan.created` NO se maneja: es el objeto heredado que Stripe reemplazó por `price`, y
       * atenderlo duplicaría cada alta de precio en el catálogo local.
       */
      case 'price.created':
      case 'price.updated': {
        const price = event.data.object as Stripe.Price;
        this.logger.log(
          `Webhook ${event.type} recibido para el precio ${price.id} (active=${price.active}).`,
        );
        await this.catalogSyncService.syncPriceUpserted(
          price,
          await this.resolvePriceProduct(price),
        );
        this.logger.log(`Precio ${price.id} sincronizado tras ${event.type}.`);
        break;
      }
      default:
        this.logger.log(`Evento de Stripe sin manejar: ${event.type}`);
    }
  }

  /**
   * El producto del precio, que es donde vive la metadata que enruta el evento. En el payload de
   * un webhook `product` llega como id (Stripe no expande nada en los eventos), así que hay que
   * ir a buscarlo; si alguna vez llegara ya expandido, se usa tal cual y se ahorra la llamada.
   */
  private async resolvePriceProduct(
    price: Stripe.Price,
  ): Promise<Stripe.Product> {
    if (typeof price.product !== 'string') {
      return price.product as Stripe.Product;
    }

    return this.paymentGateway.retrieveProduct(price.product);
  }
}
