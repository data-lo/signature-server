import {
  Controller,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import Stripe = require('stripe');
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { StripeSignatureGuard } from './guards/stripe-signature.guard';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Ruta aislada del flujo de checkout: sin JWT ni x-api-key (@SkipJwtAuth()
 * deja pasar ambos guards globales), protegida únicamente por la verificación
 * de firma de Stripe en StripeSignatureGuard.
 */
@ApiExcludeController()
@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly stripeWebhookService: StripeWebhookService) {}

  @Post('webhook')
  @SkipJwtAuth()
  @UseGuards(StripeSignatureGuard)
  async handleWebhook(
    @Req() request: RawBodyRequest<Request> & { stripeEvent: Stripe.Event },
  ): Promise<{ received: true }> {
    await this.stripeWebhookService.process(request.stripeEvent);
    return { received: true };
  }
}
