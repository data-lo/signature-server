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
import { StripeSignatureGuard } from './stripe/stripe-signature.guard';
import { StripeWebhookService } from './stripe/stripe-webhook.service';

/**
 * Ruta aislada del flujo de checkout: sin JWT ni x-api-key (@SkipJwtAuth()
 * deja pasar ambos guards globales), protegida únicamente por la verificación
 * de firma de Stripe en StripeSignatureGuard.
 *
 * PENDIENTE (bloqueado por rama): este controller debe mudarse al módulo central `webhooks`
 * —`POST /api/v1/webhooks/stripe`—, que hoy sólo existe en la rama `webhooks` y todavía no está
 * en `development`. Ese módulo ya trae lo que pide el ticket: verificación de firma sobre el
 * cuerpo crudo, registro en `webhook_events` e idempotencia por `(provider, providerEventId)`.
 *
 * No se duplicó aquí a propósito: reimplementar la tabla y su migración en `payments`
 * garantizaría un conflicto al mezclar las dos ramas, y dejaría dos registros de entregas que
 * habría que reconciliar después.
 *
 * Cuando `webhooks` aterrice, la recepción se va allá y de este módulo sólo sobrevive
 * `StripeWebhookService` como efecto de dominio, invocado por `ReceiveStripeWebhookUseCase`.
 * Mientras tanto esta ruta sigue viva para no dejar los pagos sin conciliar.
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
