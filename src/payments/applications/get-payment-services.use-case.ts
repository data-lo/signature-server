import { Injectable, Logger } from '@nestjs/common';
import { PaymentService } from '../interfaces/payment-service.interface';
import { PaymentServiceResponse } from '../interfaces/payment-service-response.interface';
import { StripePaymentGatewayService } from '../stripe/stripe-payment-gateway.service';

/**
 * Catálogo de servicios comprables, tal como lo pintan las tarjetas.
 *
 * Los servicios se leen de Stripe en cada consulta y no de una tabla local ni de variables de
 * entorno: dar de alta un producto o cambiarle el precio se hace en el panel del proveedor y se
 * refleja solo. La versión anterior fijaba tres `price_id` en el `.env`, así que cada cambio
 * comercial exigía un despliegue.
 *
 * **No se crea ninguna sesión de Checkout aquí.** Cada sesión es temporal y cuesta una llamada
 * al proveedor: generarlas al listar significaría abrir tantas como tarjetas se muestran, casi
 * todas para no usarse nunca, y las que el usuario sí abriera podrían haber caducado ya. La
 * sesión se crea al pulsar "Comprar", en `CreateStripeCheckoutSessionUseCase`.
 */
@Injectable()
export class GetPaymentServicesUseCase {
  private readonly logger = new Logger(GetPaymentServicesUseCase.name);

  constructor(private readonly paymentGateway: StripePaymentGatewayService) {}

  async execute(): Promise<PaymentServiceResponse[]> {
    const services = await this.paymentGateway.listActiveServices();

    /**
     * Un catálogo vacío es la única forma en que esta pantalla se queda sin tarjetas **sin que
     * nada falle**: la respuesta es 200, el frontend dibuja "todavía no hay servicios" y en los
     * logs no queda rastro de nada. Visto desde afuera se reporta igual que un error ("no cargan
     * los planes"), así que se deja constancia explícita para poder distinguir los dos casos sin
     * tener que reproducirlo.
     */
    if (services.length === 0) {
      this.logger.warn(
        'El catálogo de Stripe no devolvió ningún servicio vendible. Revisa que la cuenta de ' +
          'este entorno tenga productos ACTIVOS con al menos un precio ACTIVO, y que la llave ' +
          'configurada sea la de esa cuenta y del modo correcto (test/live).',
      );
    }

    return services.map((service) => this.toResponse(service));
  }

  /**
   * Se recorta lo que sale hacia el navegador. El `productId` y cualquier campo interno del
   * proveedor se quedan del lado del servidor: la pantalla sólo necesita el `priceId` para
   * pedir el checkout.
   */
  private toResponse(service: PaymentService): PaymentServiceResponse {
    return {
      priceId: service.priceId,
      name: service.name,
      description: service.description,
      unitAmount: service.unitAmount,
      currency: service.currency,
      interval: service.interval,
      intervalCount: service.intervalCount,
      imageUrl: service.imageUrl,
    };
  }
}
