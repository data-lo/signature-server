import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { CreateSubscriptionCheckoutUseCase } from 'src/billing/checkout/create-subscription-checkout.use-case';
import {
  GetBillingStateUseCase,
  type BillingStateResponse,
} from 'src/billing/profiles/get-billing-state.use-case';
import { GetPublicStripePlansUseCase } from './applications/get-public-stripe-plans.use-case';
import { GetSubscriptionStateUseCase } from './applications/get-subscription-state.use-case';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CheckoutSessionResponse } from './interfaces/checkout-session-response.interface';
import { PaymentServiceResponse } from './interfaces/payment-service-response.interface';
import { UserSubscriptionState } from './interfaces/user-subscription-state.interface';
import { ApiGetPaymentServices } from './docs/api-get-payment-services.docs';
import { ApiCreateCheckoutSession } from './docs/api-create-checkout-session.docs';
import { ApiGetSubscriptionState } from './docs/api-get-subscription-state.docs';
import { ApiGetBillingState } from './docs/api-get-billing-state.docs';

/**
 * Endpoints autenticados del catálogo y la compra.
 *
 * El controller sólo traduce HTTP: cada endpoint delega en un caso de uso de `applications/`.
 * Acá NO llega el resultado del pago — eso entra por webhook firmado, en su propio controller.
 */
@ApiTags('Payments')
@ApiBearerAuth('access-token')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly getPublicStripePlans: GetPublicStripePlansUseCase,
    private readonly createSubscriptionCheckout: CreateSubscriptionCheckoutUseCase,
    private readonly getSubscriptionState: GetSubscriptionStateUseCase,
    private readonly getBillingState: GetBillingStateUseCase,
  ) {}

  /**
   * Catálogo público de planes. Conserva la ruta `services` que ya consume el frontend: lo que
   * cambió es qué devuelve —sólo productos marcados como plan visible en Stripe— y que la
   * respuesta se sirve desde Redis mientras el TTL siga vigente.
   */
  @Get('services')
  @ApiGetPaymentServices()
  async services(): Promise<BaseResponse<PaymentServiceResponse[]>> {
    return {
      success: true,
      message: 'Planes obtenidos correctamente',
      data: await this.getPublicStripePlans.execute(),
    };
  }

  /**
   * La sesión se crea acá y sólo acá: el catálogo no devuelve URLs de pago porque caducan y
   * cada una cuesta una llamada al proveedor.
   *
   * `X-Account-Id` no es opcional: determina a quién se le factura (a la persona o a la
   * organización entera) y, con ello, qué perfil recibe el saldo de documentos. Se valida dentro
   * del caso de uso que el usuario autenticado pertenezca de verdad a esa cuenta.
   */
  @Post('checkout-sessions')
  @ApiCreateCheckoutSession()
  async checkoutSessions(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<BaseResponse<CheckoutSessionResponse>> {
    return {
      success: true,
      message: 'Sesión de Checkout creada correctamente',
      data: await this.createSubscriptionCheckout.execute({
        userId: user.sub,
        email: user.email,
        accountId,
        priceId: dto.priceId,
      }),
    };
  }

  /**
   * Estado de facturación de la cuenta activa: lo que el frontend consulta al entrar, al
   * cambiar de cuenta y al volver de Checkout.
   *
   * Lleva `X-Account-Id` por el mismo motivo que el checkout, y no por simetría: un usuario con
   * cuenta personal y organización tiene DOS estados de facturación distintos a la vez, y cuál
   * de los dos se responde depende de en cuál esté trabajando. Sin el header no habría forma de
   * saberlo.
   */
  @Get('billing-state')
  @ApiGetBillingState()
  async billingState(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
  ): Promise<BaseResponse<BillingStateResponse>> {
    return {
      success: true,
      message: 'Estado de facturación obtenido correctamente',
      data: await this.getBillingState.execute({
        userId: user.sub,
        accountId,
      }),
    };
  }

  /**
   * Hermano detallado de `billing-state`: sale del MISMO `billing_profile` y coincide con él en
   * `hasActiveSubscription`, pero añade el estado concreto y las fechas del periodo.
   *
   * Los dos existen a propósito y no por descuido. `billing-state` es la consulta ligera que la
   * aplicación hace en todas partes —al entrar y al cambiar de cuenta— para saber si el servicio
   * está habilitado; ésta es la que necesita la pantalla de suscripciones, que además tiene que
   * decir bajo qué plan y hasta cuándo. Ver el docblock de `ApiGetSubscriptionState`.
   */
  @Get('subscription')
  @ApiGetSubscriptionState()
  async subscription(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
  ): Promise<BaseResponse<UserSubscriptionState>> {
    return {
      success: true,
      message: 'Estado de suscripción obtenido correctamente',
      data: await this.getSubscriptionState.execute({
        userId: user.sub,
        accountId,
      }),
    };
  }
}
