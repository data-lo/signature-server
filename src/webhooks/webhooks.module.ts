import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from 'src/payments/payments.module';
import { IdentityVerificationModule } from 'src/identity-verification/identity-verification.module';
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
 * identidad o cómo cambia una suscripción; eso vive en `identity-verification` y en `payments`.
 *
 * `PaymentsModule` se importa por dos piezas que pertenecen al dominio de pagos:
 * `StripePaymentGatewayService` (el cliente ya configurado, con el que se verifica la firma) y
 * `StripeWebhookService` (el destinatario de la delegación). La dependencia va en un solo
 * sentido: `payments` no conoce a `webhooks`.
 *
 * `IdentityVerificationModule` se importa por `ProcessDiditVerificationResultUseCase`, que es
 * quien interpreta el resultado de una sesión de Didit y mueve el estado del usuario. La
 * dependencia va también en un solo sentido: `identity-verification` no conoce a `webhooks` — no
 * tiene controller de webhooks ni verificación de firma, por diseño.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEventEntity]),
    PaymentsModule,
    IdentityVerificationModule,
  ],
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
