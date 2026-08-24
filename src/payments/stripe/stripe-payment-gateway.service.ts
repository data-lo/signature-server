import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe = require('stripe');
import { PaymentService } from '../interfaces/payment-service.interface';
import { PaymentGatewayUnavailableException } from '../exceptions/payments.exceptions';

/**
 * Cuántos precios activos se traen del catálogo como máximo. Stripe pagina de 10 en 10 por
 * defecto; 100 es su tope por página y cubre de sobra un catálogo de servicios, así que se
 * evita paginar por algo que hoy son unas pocas tarjetas.
 */
const CATALOG_PAGE_SIZE = 100;

/**
 * Adaptador hacia Stripe: el único archivo del módulo que conoce su SDK.
 *
 * No es el servicio de dominio de `payments`. No decide qué se puede comprar ni qué significa
 * una suscripción activa; traduce entre el vocabulario de Stripe (productos, precios, sesiones
 * de Checkout) y el nuestro. Si mañana entra un segundo proveedor, se agrega otro adaptador y
 * los casos de uso no cambian.
 *
 * La llave secreta vive sólo aquí y nunca sale hacia el cliente: al frontend únicamente le
 * llega la URL hospedada de Checkout.
 */
@Injectable()
export class StripePaymentGatewayService {
  private readonly logger = new Logger(StripePaymentGatewayService.name);

  /**
   * Se expone porque la verificación de firma del webhook usa `client.webhooks.constructEvent`,
   * que necesita el mismo cliente configurado. Ningún otro consumidor debería tocarlo.
   */
  readonly client: Stripe;

  constructor(private readonly configService: ConfigService) {
    this.client = new Stripe(
      this.configService.get<string>('STRIPE_SECRET_KEY'),
    );
  }

  /**
   * Catálogo de servicios activos, armado desde los precios activos de Stripe.
   *
   * Se consulta por precios y no por productos porque el precio es lo que se compra: un
   * producto sin precio activo no es vendible, y uno con dos precios (mensual y anual) son dos
   * tarjetas distintas. `expand: product` evita una llamada por cada precio para leer su
   * nombre e imagen.
   */
  async listActiveServices(): Promise<PaymentService[]> {
    try {
      const prices = await this.client.prices.list({
        active: true,
        limit: CATALOG_PAGE_SIZE,
        expand: ['data.product'],
      });

      return prices.data
        .filter((price) => this.isSellable(price))
        .map((price) => this.toPaymentService(price));
    } catch (error) {
      this.logger.error(
        `No se pudo leer el catálogo de Stripe: ${this.describe(error)}`,
      );
      throw new PaymentGatewayUnavailableException();
    }
  }

  /**
   * @param priceId Precio ya validado contra el catálogo por el caso de uso: este método no
   *   vuelve a comprobarlo, sólo crea la sesión.
   * @returns La URL hospedada de Checkout, temporal por definición.
   */
  async createCheckoutSession(input: {
    priceId: string;
    mode: Stripe.Checkout.SessionCreateParams.Mode;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    try {
      const session = await this.client.checkout.sessions.create({
        mode: input.mode,
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata: input.metadata,
        /**
         * La misma metadata se copia a la suscripción porque los eventos posteriores
         * (`invoice.paid`, `customer.subscription.deleted`) no traen la de la sesión: sin esto,
         * al renovar no habría forma de saber a qué cuenta pertenece el cobro.
         */
        ...(input.mode === 'subscription'
          ? { subscription_data: { metadata: input.metadata } }
          : {}),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });

      if (!session.url) {
        // Stripe sólo omite la URL en modos que no usamos (`ui_mode: 'embedded'`). Si llega
        // vacía, es un cambio de contrato y no algo que el usuario pueda resolver reintentando.
        throw new Error('Stripe creó la sesión sin URL de Checkout');
      }

      return session.url;
    } catch (error) {
      this.logger.error(
        `No se pudo crear la sesión de Checkout para ${input.priceId}: ${this.describe(error)}`,
      );
      throw new PaymentGatewayUnavailableException();
    }
  }

  /** Crea el cliente de Stripe con el que se factura a la cuenta. */
  async createCustomer(accountId: string, email: string): Promise<string> {
    try {
      const customer = await this.client.customers.create({
        email,
        metadata: { accountId },
      });
      return customer.id;
    } catch (error) {
      this.logger.error(
        `No se pudo crear el cliente de Stripe de la cuenta ${accountId}: ${this.describe(error)}`,
      );
      throw new PaymentGatewayUnavailableException();
    }
  }

  /**
   * Un precio sin producto expandido, con el producto inactivo o borrado no es vendible. Se
   * filtra acá y no en el caso de uso porque es una particularidad del catálogo de Stripe, no
   * una regla de negocio nuestra.
   */
  private isSellable(price: Stripe.Price): boolean {
    const product = price.product;

    /**
     * `'active' in product` y no `!product.deleted`: un producto borrado no trae `active`, y
     * ese `in` es lo que estrecha la unión `Product | DeletedProduct` para TypeScript.
     */
    if (typeof product === 'string' || !('active' in product)) {
      return false;
    }

    return product.active === true;
  }

  private toPaymentService(price: Stripe.Price): PaymentService {
    const product = price.product as Stripe.Product;

    return {
      priceId: price.id,
      productId: product.id,
      name: product.name,
      description: product.description ?? null,
      unitAmount: price.unit_amount ?? null,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
      intervalCount: price.recurring?.interval_count ?? null,
      imageUrl: product.images?.[0] ?? null,
    };
  }

  /** Nunca se registra el error crudo de Stripe: puede llevar fragmentos de la petición. */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'error desconocido';
  }
}
