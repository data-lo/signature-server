import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StripeModule } from 'src/stripe/stripe.module';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import { DiditWebhookSignatureVerifierService } from './didit/didit-webhook-signature-verifier.service';
import { StripeWebhookSignatureVerifierService } from './stripe/stripe-webhook-signature-verifier.service';
import { RegisterWebhookEventUseCase } from './applications/register-webhook-event.use-case';
import { ReceiveDiditWebhookUseCase } from './applications/receive-didit-webhook.use-case';
import { ReceiveStripeWebhookUseCase } from './applications/receive-stripe-webhook.use-case';
import { DiditWebhookController } from './didit-webhook.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * Punto de entrada único de los webhooks de proveedores externos.
 *
 * Responsabilidades del módulo: recibir el cuerpo crudo, verificar la firma del proveedor,
 * registrar la entrega de forma idempotente en `webhook_events` y delegar al caso de uso del
 * dominio correspondiente. Nada más — no hay aquí una sola regla sobre cuándo se aprueba una
 * identidad o cómo cambia una suscripción; eso vive en `identity-verification` y en `stripe`.
 *
 * `StripeModule` se importa por dos piezas que pertenecen al dominio de pagos: `StripeService`
 * (el cliente ya configurado, que verifica la firma) y `StripeWebhookService` (el destinatario
 * de la delegación). La dependencia va en un solo sentido: `stripe` no conoce a `webhooks`.
 *
 * Para Didit la delegación es un puerto opcional — ver
 * `interfaces/didit-verification-processor.interface.ts`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebhookEventEntity]), StripeModule],
  controllers: [DiditWebhookController, StripeWebhookController],
  providers: [
    DiditWebhookSignatureVerifierService,
    StripeWebhookSignatureVerifierService,
    RegisterWebhookEventUseCase,
    ReceiveDiditWebhookUseCase,
    ReceiveStripeWebhookUseCase,
  ],
  exports: [RegisterWebhookEventUseCase],
})
export class WebhooksModule {}
