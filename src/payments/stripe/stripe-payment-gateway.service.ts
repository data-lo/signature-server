import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe = require('stripe');
import { PaymentService } from '../interfaces/payment-service.interface';
import {
  PaymentGatewayMisconfiguredException,
  PaymentGatewayUnavailableException,
} from '../exceptions/payments.exceptions';

/**
 * Errores con los que Stripe dice "tus credenciales no sirven": la llave no vale o fue revocada
 * (401) y la llave no tiene permiso para este recurso (403), el caso típico de una *restricted
 * key* a la que no se le dio lectura de productos y precios.
 *
 * Ninguno se arregla reintentando, así que no pueden reportarse como "el proveedor no está
 * disponible": son configuración nuestra.
 */
const CREDENTIAL_ERROR_TYPES = [
  'StripeAuthenticationError',
  'StripePermissionError',
];

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
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    /**
     * Sin llave, el SDK ya fallaba solo — pero con "Neither apiKey nor config.authenticator
     * provided", que no nombra la variable ni el despliegue donde falta. Como el fallo ocurre
     * al construir el proveedor, se lleva por delante el arranque de TODA la aplicación: quien
     * mire el log tiene que poder leer en la primera línea qué le falta al entorno.
     */
    if (!secretKey) {
      throw new Error(
        'Falta STRIPE_SECRET_KEY en las variables de entorno: el módulo de pagos no puede iniciarse.',
      );
    }

    this.client = new Stripe(secretKey);

    this.logKeyKind(secretKey);
  }

  /**
   * Una línea al arrancar que dice con qué clase de llave quedó configurado el despliegue.
   *
   * Existe por un caso real: el catálogo se veía vacío o daba error en el servidor y no en local,
   * y desde afuera no había forma de saber si el entorno apuntaba a otra cuenta de Stripe, al
   * modo equivocado, o usaba una *restricted key* sin permisos. Se registra sólo el prefijo
   * —jamás la llave, ni siquiera truncada— porque es lo único que hace falta para responder esa
   * pregunta.
   */
  private logKeyKind(secretKey: string): void {
    const isRestricted = secretKey.startsWith('rk_');
    const mode = secretKey.includes('_live_') ? 'live' : 'test';

    this.logger.log(
      `Stripe configurado en modo ${mode} con una llave ${isRestricted ? 'restringida (rk_)' : 'secreta (sk_)'}.` +
        (isRestricted
          ? ' Una llave restringida necesita permiso de LECTURA sobre productos y precios, o el catálogo responderá 403.'
          : ''),
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
      throw this.translateError(error, 'leer el catálogo de servicios');
    }
  }

  /**
   * @param priceId Precio ya validado contra el catálogo por el caso de uso: este método no
   *   vuelve a comprobarlo, sólo crea la sesión.
   * @returns El `cs_...` de la sesión y su URL hospedada, temporal por definición.
   *
   * Devuelve el `sessionId` además de la URL —antes sólo la URL— porque es la llave con la que
   * `checkout_orders` se reconcilia después: `checkout.session.completed` sólo trae el id de la
   * sesión, así que sin guardarlo al crearla no habría forma de encontrar la orden pendiente que
   * le corresponde.
   */
  async createCheckoutSession(input: {
    priceId: string;
    mode: Stripe.Checkout.SessionCreateParams.Mode;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ sessionId: string; checkoutUrl: string }> {
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

      return { sessionId: session.id, checkoutUrl: session.url };
    } catch (error) {
      throw this.translateError(
        error,
        `crear la sesión de Checkout para ${input.priceId}`,
      );
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
      throw this.translateError(
        error,
        `crear el cliente de Stripe de la cuenta ${accountId}`,
      );
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

  /**
   * Traduce un fallo de Stripe a la excepción que le corresponde, y lo registra una sola vez.
   *
   * La distinción que hace este método es la que faltaba: **credenciales rechazadas no es lo
   * mismo que proveedor caído**. Antes las tres llamadas devolvían 502 pasara lo que pasara, así
   * que una llave equivocada en el despliegue se presentaba como "Stripe no está disponible" y
   * mandaba a buscar el problema al lado del proveedor, donde no estaba.
   *
   * @param action Qué se estaba intentando, para que el log diga cuál de las tres llamadas falló.
   */
  private translateError(error: unknown, action: string): Error {
    if (this.isCredentialError(error)) {
      this.logger.error(
        `Stripe rechazó nuestras credenciales al ${action}: ${this.describe(error)}. ` +
          'Revisa STRIPE_SECRET_KEY en este entorno — que sea de la cuenta correcta, que no esté ' +
          'revocada y, si es una llave restringida, que tenga permiso de lectura sobre productos y precios.',
      );

      return new PaymentGatewayMisconfiguredException();
    }

    this.logger.error(`No se pudo ${action}: ${this.describe(error)}`);

    return new PaymentGatewayUnavailableException();
  }

  /**
   * Se mira `type` —el discriminador que el propio SDK pone en sus errores— y no `instanceof`:
   * las clases de error de Stripe no son estables entre versiones del paquete y `instanceof`
   * falla en cuanto conviven dos copias del módulo, un caso nada exótico en un monorepo.
   * `statusCode` cubre el error genérico que no trae `type`.
   */
  private isCredentialError(error: unknown): boolean {
    const stripeError = error as { type?: string; statusCode?: number };

    return (
      CREDENTIAL_ERROR_TYPES.includes(stripeError?.type) ||
      stripeError?.statusCode === 401 ||
      stripeError?.statusCode === 403
    );
  }

  /** Nunca se registra el error crudo de Stripe: puede llevar fragmentos de la petición. */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'error desconocido';
  }
}
