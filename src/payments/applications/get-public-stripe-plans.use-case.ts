import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/shared/redis/redis.service';
import { PaymentService } from '../interfaces/payment-service.interface';
import { PaymentServiceResponse } from '../interfaces/payment-service-response.interface';
import { StripePaymentService } from '../stripe/stripe-payment.service';

/** Clave única del catálogo público: es el mismo para todos, no depende de quién pregunte. */
export const PUBLIC_STRIPE_PLANS_CACHE_KEY = 'payments:public-stripe-plans';

/** 10 minutos. Un cambio de precio en el dashboard tarda como mucho eso en verse. */
export const PUBLIC_STRIPE_PLANS_CACHE_TTL_SECONDS = 600;

/**
 * Devuelve el catálogo de planes públicos, tal como lo pintan las tarjetas.
 *
 * Los planes se leen de Stripe y no de una tabla local ni de variables de entorno: dar de alta un
 * producto o cambiarle el precio se hace en el panel del proveedor y se refleja solo. Qué productos
 * son públicos también se decide allá, con `catalogType=plan` + `visibility=true`; el filtro concreto
 * vive en `StripePaymentService` porque `prices.list()` no sabe filtrar por metadata.
 *
 * **Cachea 10 minutos en Redis**: sin eso, cada visita a la pantalla era una llamada a Stripe aunque
 * el catálogo cambie unas pocas veces al año. El precio es que un cambio hecho en el dashboard tarda
 * hasta ese TTL en verse.
 *
 * El plan gratuito no aparece acá y no es un olvido: no se administra en Stripe, así que no tiene
 * producto ni precio que listar.
 *
 * **No crea ninguna sesión de Checkout**: cada una es temporal y cuesta una llamada al proveedor, así
 * que generarlas al listar abriría tantas como tarjetas, casi todas para no usarse nunca. La sesión
 * se crea al pulsar "Comprar", en `CreateSubscriptionCheckoutUseCase`.
 */
@Injectable()
export class GetPublicStripePlansUseCase {
  private readonly logger = new Logger(GetPublicStripePlansUseCase.name);

  constructor(
    private readonly paymentService: StripePaymentService,
    private readonly redisService: RedisService,
  ) {}

  async execute(): Promise<PaymentServiceResponse[]> {
    const cached = await this.readCache();
    if (cached) {
      return cached;
    }

    const plans = await this.paymentService.listPublicPlans();

    /**
     * Un catálogo vacío es la única forma en que esta pantalla se queda sin tarjetas **sin que
     * nada falle**: la respuesta es 200, el frontend dibuja "todavía no hay planes" y en los
     * logs no queda rastro de nada. Visto desde afuera se reporta igual que un error ("no cargan
     * los planes"), así que se deja constancia explícita para poder distinguir los dos casos sin
     * tener que reproducirlo.
     */
    if (plans.length === 0) {
      this.logger.warn(
        'El catálogo de Stripe no devolvió ningún plan público. Revisa que la cuenta de este ' +
          'entorno tenga productos ACTIVOS con al menos un precio ACTIVO y con la metadata ' +
          "catalogType='plan' y visibility='true', y que la llave configurada sea la de esa " +
          'cuenta y del modo correcto (test/live).',
      );
    }

    const response = plans.map((plan) => this.toResponse(plan));

    await this.writeCache(response);

    return response;
  }

  /**
   * Trata a Redis como optimización y no como fuente de verdad: si está caído o devuelve algo
   * ilegible —un despliegue que cambió la forma de la respuesta y dejó claves viejas— se sigue con
   * Stripe. Lo contrario convertiría una caída del caché en una caída del catálogo, peor que la
   * situación previa a tenerlo.
   */
  private async readCache(): Promise<PaymentServiceResponse[] | null> {
    try {
      const raw = await this.redisService.get(PUBLIC_STRIPE_PLANS_CACHE_KEY);
      return raw ? (JSON.parse(raw) as PaymentServiceResponse[]) : null;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer el catálogo de planes desde Redis, se consulta a Stripe: ${this.describe(error)}`,
      );
      return null;
    }
  }

  private async writeCache(plans: PaymentServiceResponse[]): Promise<void> {
    try {
      await this.redisService.set(
        PUBLIC_STRIPE_PLANS_CACHE_KEY,
        JSON.stringify(plans),
        PUBLIC_STRIPE_PLANS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      // El catálogo ya está listo: no poder guardarlo sólo significa que la próxima consulta
      // volverá a Stripe, no que ésta deba fallar.
      this.logger.warn(
        `No se pudo cachear el catálogo de planes en Redis: ${this.describe(error)}`,
      );
    }
  }

  /**
   * Recorta lo que sale hacia el navegador: el `productId` y cualquier campo interno del proveedor
   * se quedan del lado del servidor, porque la pantalla sólo necesita el `priceId` para pedir el
   * checkout. Normaliza ANTES de cachear, así lo guardado es exactamente lo que se responde y un
   * cache hit no tiene que volver a mapear nada.
   */
  private toResponse(plan: PaymentService): PaymentServiceResponse {
    return {
      priceId: plan.priceId,
      name: plan.name,
      description: plan.description,
      unitAmount: plan.unitAmount,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      imageUrl: plan.imageUrl,
    };
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'error desconocido';
  }
}
