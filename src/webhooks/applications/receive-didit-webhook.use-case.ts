import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DiditWebhookSignatureVerifierService } from '../didit/didit-webhook-signature-verifier.service';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import {
  DIDIT_VERIFICATION_PROCESSOR,
  DiditVerificationProcessor,
} from '../interfaces/didit-verification-processor.interface';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';

interface ReceiveDiditWebhookInput {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Orquesta una entrega de Didit: autenticar → registrar → delegar → cerrar el estado.
 *
 * No decide nada sobre la identidad de nadie. La única pregunta que responde es si el evento
 * viene realmente de Didit y si ya lo habíamos procesado.
 */
@Injectable()
export class ReceiveDiditWebhookUseCase {
  private readonly logger = new Logger(ReceiveDiditWebhookUseCase.name);

  constructor(
    private readonly signatureVerifier: DiditWebhookSignatureVerifierService,
    private readonly registerWebhookEvent: RegisterWebhookEventUseCase,
    /**
     * Opcional a propósito: `identity-verification` todavía no existe en el repositorio.
     * Ver `DIDIT_VERIFICATION_PROCESSOR` para cómo se ata cuando llegue.
     */
    @Optional()
    @Inject(DIDIT_VERIFICATION_PROCESSOR)
    private readonly processDiditVerificationResult?: DiditVerificationProcessor,
  ) {}

  async execute(
    input: ReceiveDiditWebhookInput,
  ): Promise<WebhookReceptionResult> {
    // Primero la firma, antes de mirar una sola propiedad del cuerpo: un POST falso no puede
    // aprobar una identidad, y tampoco puede sembrar datos en `webhook_events`.
    const isAuthentic = this.signatureVerifier.verify(
      input.rawBody,
      input.signature,
      input.timestamp,
    );

    if (!isAuthentic) {
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        'Firma HMAC de Didit inválida, ausente o expirada',
      );
      throw new UnauthorizedException('Firma de Didit inválida');
    }

    const payload = this.parse(input.rawBody);

    const { event, alreadyProcessed } =
      await this.registerWebhookEvent.register({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        providerEventId: this.resolveEventId(payload),
        eventType: this.resolveEventType(payload),
        payload,
      });

    if (alreadyProcessed) {
      return { received: true, duplicate: true };
    }

    if (!this.processDiditVerificationResult) {
      /**
       * El evento queda guardado y en RECEIVED, no en FAILED, porque no falló nada:
       * simplemente todavía no hay dominio que lo consuma. Se responde 200 para que Didit no entre en
       * ciclo de reintentos, y como no está en PROCESSED, una re-entrega futura (ya con
       * `identity-verification` desplegado) sí ejecutará las reglas.
       */
      this.logger.warn(
        `Webhook de Didit ${event.providerEventId ?? event.id} registrado sin procesar: ` +
          'no hay ProcessDiditVerificationResultUseCase atado a DIDIT_VERIFICATION_PROCESSOR.',
      );
      return { received: true, duplicate: false };
    }

    try {
      await this.processDiditVerificationResult.execute(payload);
    } catch (error) {
      await this.registerWebhookEvent.markFailed(event.id, error);
      this.logger.error(
        `Falló el procesamiento del webhook de Didit ${event.providerEventId ?? event.id}.`,
        error instanceof Error ? error.stack : undefined,
      );
      // Se propaga para responder 5xx: así Didit reintenta la entrega, y la fila en FAILED
      // conserva el detalle de por qué no se pudo la primera vez.
      throw error;
    }

    await this.registerWebhookEvent.markProcessed(event.id);
    return { received: true, duplicate: false };
  }

  private parse(rawBody: Buffer): Record<string, unknown> {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('El cuerpo del webhook no es un objeto JSON');
      }

      return parsed as Record<string, unknown>;
    } catch {
      // Firmado con nuestro secreto pero ilegible: no es un atacante, es un contrato roto.
      throw new BadRequestException('Cuerpo de webhook de Didit inválido');
    }
  }

  /**
   * Clave de idempotencia de Didit.
   *
   * Didit no manda un `evt_...` como Stripe: manda `session_id`, que es estable durante toda la
   * sesión de verificación y se repite en cada cambio de estado (`In Progress` → `Approved`).
   * Usar sólo `session_id` haría que el segundo cambio de estado — el que de verdad importa —
   * se descartara como duplicado, así que la clave combina sesión y estado. Si algún día el
   * proveedor incluye un identificador propio de entrega (`webhook_id`), ese gana.
   */
  private resolveEventId(payload: Record<string, unknown>): string | null {
    const webhookId = this.asString(payload.webhook_id);
    if (webhookId) {
      return webhookId;
    }

    const sessionId = this.asString(payload.session_id);
    if (!sessionId) {
      return null;
    }

    const status = this.asString(payload.status);
    return status ? `${sessionId}:${status}` : sessionId;
  }

  private resolveEventType(payload: Record<string, unknown>): string {
    return (
      this.asString(payload.webhook_type) ??
      this.asString(payload.status) ??
      'unknown'
    );
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
