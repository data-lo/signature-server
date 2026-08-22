import { Injectable } from '@nestjs/common';
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
  constructor(private readonly paymentGateway: StripePaymentGatewayService) {}

  async execute(): Promise<PaymentServiceResponse[]> {
    const services = await this.paymentGateway.listActiveServices();

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
