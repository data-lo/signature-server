import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { StripeService } from './stripe.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { PlanDetails } from './interfaces/plan-details.interface';
import { StripeCheckoutResponse } from './interfaces/stripe-checkout-response.interface';
import { UserSubscriptionState } from './interfaces/user-subscription-state.interface';
import { ApiGetPlans } from './docs/api-get-plans.docs';
import { ApiCreateCheckoutSession } from './docs/api-create-checkout-session.docs';
import { ApiGetSubscriptionState } from './docs/api-get-subscription-state.docs';

@ApiTags('Stripe')
@ApiBearerAuth('access-token')
@Controller('stripe')
export class StripeCheckoutController {
  constructor(private readonly stripeService: StripeService) {}

  @Get('plans')
  @ApiGetPlans()
  async getPlans(): Promise<BaseResponse<PlanDetails[]>> {
    return {
      success: true,
      message: 'Planes obtenidos correctamente',
      data: this.stripeService.getPlans(),
    };
  }

  @Post('checkout/session')
  @ApiCreateCheckoutSession()
  async createCheckoutSession(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<BaseResponse<StripeCheckoutResponse>> {
    const accountId = await this.stripeService.resolveAccountId(user.sub);
    const data = await this.stripeService.createCheckoutSession(
      accountId,
      user.email,
      dto.planId,
    );

    return {
      success: true,
      message: 'Sesión de Checkout creada correctamente',
      data,
    };
  }

  @Get('subscription')
  @ApiGetSubscriptionState()
  async getSubscriptionState(
    @CurrentUser() user: JwtPayload,
  ): Promise<BaseResponse<UserSubscriptionState>> {
    const accountId = await this.stripeService.resolveAccountId(user.sub);
    const data = await this.stripeService.getSubscriptionState(accountId);

    return {
      success: true,
      message: 'Estado de suscripción obtenido correctamente',
      data,
    };
  }
}
