import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { CreateSubscriptionCheckoutUseCase } from 'src/billing/checkout/create-subscription-checkout.use-case';
import { GetPaymentServicesUseCase } from './applications/get-payment-services.use-case';
import { GetSubscriptionStateUseCase } from './applications/get-subscription-state.use-case';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CheckoutSessionResponse } from './interfaces/checkout-session-response.interface';
import { PaymentServiceResponse } from './interfaces/payment-service-response.interface';
import { UserSubscriptionState } from './interfaces/user-subscription-state.interface';
import { ApiGetPaymentServices } from './docs/api-get-payment-services.docs';
import { ApiCreateCheckoutSession } from './docs/api-create-checkout-session.docs';
import { ApiGetSubscriptionState } from './docs/api-get-subscription-state.docs';

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
    private readonly getPaymentServices: GetPaymentServicesUseCase,
    private readonly createSubscriptionCheckout: CreateSubscriptionCheckoutUseCase,
    private readonly getSubscriptionState: GetSubscriptionStateUseCase,
  ) {}

  @Get('services')
  @ApiGetPaymentServices()
  async services(): Promise<BaseResponse<PaymentServiceResponse[]>> {
    return {
      success: true,
      message: 'Servicios obtenidos correctamente',
      data: await this.getPaymentServices.execute(),
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

  @Get('subscription')
  @ApiGetSubscriptionState()
  async subscription(
    @CurrentUser() user: JwtPayload,
  ): Promise<BaseResponse<UserSubscriptionState>> {
    return {
      success: true,
      message: 'Estado de suscripción obtenido correctamente',
      data: await this.getSubscriptionState.execute(user.sub),
    };
  }
}
