import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingProfileEntity } from './billing-profile.entity';

/**
 * El cliente de Stripe de un perfil de facturación: uno solo, creado la primera vez que intenta
 * pagar.
 *
 * **Vive aparte porque ahora lo necesitan dos flujos** —contratar un plan y comprar documentos
 * sueltos— y la regla que sostiene no admite dos copias. Si cada checkout creara su cliente, el
 * historial de facturación del mismo propietario quedaría repartido entre clientes distintos, los
 * eventos de renovación no podrían reconciliarse por cliente, y el usuario vería sus compras
 * separadas en el portal de Stripe sin ninguna razón que se le pueda explicar.
 */
@Injectable()
export class StripeCustomerService {
  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    private readonly paymentGateway: StripePaymentService,
  ) {}

  /**
   * Devuelve el cliente de Stripe del perfil, creándolo la primera vez.
   *
   * Muta el `profile` recibido además de escribir en la base: quien lo llamó suele seguir usando
   * esa instancia en la misma petición, y dejarla con el `stripeCustomerId` viejo llevaría a
   * crear un segundo cliente en el siguiente paso del mismo flujo.
   *
   * @param profile - Perfil de facturación de la cuenta activa.
   * @param email - Correo del usuario que paga, para que el cliente sea identificable en Stripe.
   * @returns El `cus_...` del perfil.
   *
   * @throws {StripeCredentialsRejectedException} Si Stripe rechaza las credenciales al crear el
   *   cliente (lo traduce `StripePaymentService`).
   *
   * @example
   * const customerId = await this.stripeCustomerService.resolveForProfile(profile, user.email);
   */
  async resolveForProfile(
    profile: BillingProfileEntity,
    email: string,
  ): Promise<string> {
    if (profile.stripeCustomerId) {
      return profile.stripeCustomerId;
    }

    const customerId = await this.paymentGateway.createCustomer(
      profile.id,
      email,
    );

    await this.billingProfileRepository.update(profile.id, {
      stripeCustomerId: customerId,
    });
    profile.stripeCustomerId = customerId;

    return customerId;
  }
}
