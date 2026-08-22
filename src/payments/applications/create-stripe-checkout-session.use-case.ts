import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';
import { CheckoutSessionResponse } from '../interfaces/checkout-session-response.interface';
import { PaymentService } from '../interfaces/payment-service.interface';
import { PaymentServiceNotAvailableException } from '../exceptions/payments.exceptions';
import { StripePaymentGatewayService } from '../stripe/stripe-payment-gateway.service';

/**
 * A dónde vuelve el usuario cuando Stripe termina. Ambas rutas llevan a suscripciones y no de
 * vuelta al catálogo: después de pagar, lo que el usuario quiere ver es el estado de lo que
 * acaba de contratar.
 *
 * `{CHECKOUT_SESSION_ID}` lo sustituye Stripe al redirigir. Sirve para acusar recibo en la
 * pantalla, no para dar el pago por bueno: quien confirma la suscripción es el webhook firmado.
 */
const SUCCESS_PATH =
  '/dashboard/subscriptions?payment=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?payment=cancel';

/**
 * Abre una sesión de Checkout para un servicio del catálogo y devuelve su URL temporal.
 *
 * Se ejecuta al pulsar "Comprar", nunca al listar: ver `GetPaymentServicesUseCase`.
 */
@Injectable()
export class CreateStripeCheckoutSessionUseCase {
  private readonly logger = new Logger(CreateStripeCheckoutSessionUseCase.name);

  constructor(
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    private readonly paymentGateway: StripePaymentGatewayService,
  ) {}

  async execute(
    userId: string,
    email: string,
    priceId: string,
  ): Promise<CheckoutSessionResponse> {
    /**
     * El precio se valida contra el catálogo activo del proveedor y no contra una lista propia:
     * el catálogo ES la fuente de verdad de lo que se puede comprar. Sin esta comprobación,
     * cualquier usuario autenticado podría mandar un `price_...` archivado —con un importe
     * viejo— o de otro producto y obtener una URL de pago perfectamente válida.
     */
    const service = await this.findAvailableService(priceId);

    const accountId = await this.resolveAccountId(userId);
    const customerId = await this.resolveCustomerId(accountId, email);
    const frontendUrl = frontendBaseUrl();

    const checkoutUrl = await this.paymentGateway.createCheckoutSession({
      priceId: service.priceId,
      /**
       * El modo lo decide el precio, no el llamador: un precio recurrente exige `subscription`
       * y uno único exige `payment`. Deducirlo evita que el catálogo y el cobro puedan
       * describir cosas distintas.
       */
      mode: service.interval ? 'subscription' : 'payment',
      customerId,
      successUrl: `${frontendUrl}${SUCCESS_PATH}`,
      cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
      /**
       * `accountId` es lo que el webhook usa para saber a quién pertenece el pago: sin él, un
       * `checkout.session.completed` no se puede reconciliar con ninguna cuenta local.
       */
      metadata: { accountId, priceId: service.priceId },
    });

    this.logger.log(
      `Sesión de Checkout creada para la cuenta ${accountId} y el precio ${service.priceId}.`,
    );

    return { checkoutUrl };
  }

  private async findAvailableService(priceId: string): Promise<PaymentService> {
    const services = await this.paymentGateway.listActiveServices();
    const service = services.find((item) => item.priceId === priceId);

    if (!service) {
      this.logger.warn(
        `Se pidió una sesión de Checkout para el precio ${priceId}, que no está en el catálogo activo.`,
      );
      throw new PaymentServiceNotAvailableException();
    }

    return service;
  }

  /**
   * Resuelve la cuenta activa del usuario para efectos de facturación. Tras la fusión
   * Account/AccountMember (ver plan de migración ER-V2, Fase 5), `membership.id` ES el
   * identificador de contexto. Simplificación conocida y heredada: sigue sin distinguir cuenta
   * PERSONAL vs ORGANIZATION si el usuario pertenece a varias.
   */
  private async resolveAccountId(userId: string): Promise<string> {
    const membership = await this.accountRepository.findOne({
      where: { userId, isActive: true },
    });

    if (!membership) {
      throw new NotFoundException(
        'El usuario no pertenece a ninguna cuenta activa',
      );
    }

    return membership.id;
  }

  /**
   * Una cuenta tiene un solo cliente en Stripe, creado la primera vez que intenta pagar. Si se
   * creara uno por sesión, el historial de facturación de la misma cuenta quedaría repartido
   * entre clientes distintos.
   */
  private async resolveCustomerId(
    accountId: string,
    email: string,
  ): Promise<string> {
    const subscription = await this.getOrCreateSubscriptionRecord(accountId);

    if (subscription.stripeCustomerId) {
      return subscription.stripeCustomerId;
    }

    const customerId = await this.paymentGateway.createCustomer(
      accountId,
      email,
    );

    await this.subscriptionRepository.update(subscription.id, {
      stripeCustomerId: customerId,
    });

    return customerId;
  }

  private async getOrCreateSubscriptionRecord(
    accountId: string,
  ): Promise<AccountSubscriptionEntity> {
    const existing = await this.subscriptionRepository.findOne({
      where: { accountId },
    });

    if (existing) {
      return existing;
    }

    return this.subscriptionRepository.save(
      this.subscriptionRepository.create({
        accountId,
        status: SUBSCRIPTION_STATUS_ENUM.INCOMPLETE,
        signingEnabled: false,
      }),
    );
  }
}
