import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ReceiveStripeWebhookUseCase } from './applications/receive-stripe-webhook.use-case';
import { WebhookReceptionResult } from './interfaces/webhook-reception-result.interface';

/**
 * Endpoint público: lo invoca Stripe. Misma lógica que el de Didit — `@SkipJwtAuth()` para
 * saltar los guards globales, y la cabecera `stripe-signature` como única credencial, validada
 * en el caso de uso contra el cuerpo crudo.
 */
@ApiExcludeController()
@Controller('api/v1/webhooks')
export class StripeWebhookController {
  constructor(
    private readonly receiveStripeWebhook: ReceiveStripeWebhookUseCase,
  ) {}

  @Post('stripe')
  @SkipJwtAuth()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<WebhookReceptionResult> {
    return this.receiveStripeWebhook.execute({
      rawBody: request.rawBody,
      signature,
    });
  }
}
