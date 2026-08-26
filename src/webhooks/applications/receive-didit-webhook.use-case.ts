import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ProcessDiditVerificationResultUseCase } from 'src/identity-verification/applications/process-didit-verification-result.use-case';
import { DiditWebhookSignatureVerifierService } from '../didit/didit-webhook-signature-verifier.service';
import { validateDiditWebhookPayload } from '../didit/didit-webhook-payload.schema';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';

interface ReceiveDiditWebhookInput {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Orquesta una entrega de Didit: autenticar → validar la forma → registrar → delegar → cerrar
 * el estado.
 *
 * No decide nada sobre la identidad de nadie. Las únicas preguntas que responde son si el evento
 * viene realmente de Didit, si tiene la forma que el proveedor documenta y si ya lo habíamos
 * procesado. El significado del resultado vive en `ProcessDiditVerificationResultUseCase`.
 */
@Injectable()
export class ReceiveDiditWebhookUseCase {
  private readonly logger = new Logger(ReceiveDiditWebhookUseCase.name);

  constructor(
    private readonly signatureVerifier: DiditWebhookSignatureVerifierService,
    private readonly registerWebhookEvent: RegisterWebhookEventUseCase,
    /**
     * Dependencia directa y obligatoria: todo webhook válido de Didit tiene que llegar al
     * dominio. La dependencia va en un solo sentido —`webhooks` importa
     * `IdentityVerificationModule`, nunca al revés—, así que no hace falta un puerto intermedio.
     */
    private readonly processDiditVerificationResult: ProcessDiditVerificationResultUseCase,
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
    const validation = validateDiditWebhookPayload(payload);

    if (validation.reason) {
      /**
       * Auténtico pero deforme. Se audita —con `signature_valid = true`, que es la verdad— y se
       * corta acá: nada de lo que sigue puede correr sobre un cuerpo que no se entiende, ni la
       * verificación ni el estado global del usuario.
       */
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        `Payload de Didit inválido: ${validation.reason}`,
        { signatureValid: true, eventType: 'invalid_payload' },
      );
      this.logger.warn(`Payload de Didit inválido: ${validation.reason}`);
      throw new BadRequestException('Payload de webhook de Didit inválido');
    }

    const { event, alreadyProcessed } =
      await this.registerWebhookEvent.register({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        /**
         * Clave de idempotencia: `event_id` identifica **la entrega**, mientras que `session_id`
         * identifica la sesión y se repite en cada cambio de estado. Usar la sesión —sola o
         * combinada con el estado— haría que una re-entrega con datos corregidos del mismo
         * estado se descartara como duplicado.
         */
        providerEventId: validation.payload.event_id,
        providerResourceId: validation.payload.session_id,
        eventType: validation.payload.webhook_type,
        payload: validation.payload,
      });

    if (alreadyProcessed) {
      return { received: true, duplicate: true };
    }

    try {
      await this.processDiditVerificationResult.execute(validation.payload);
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

  /**
   * Devuelve `unknown` a propósito: lo único que garantiza `JSON.parse` es que el texto era JSON,
   * no que sea un objeto. Afirmar acá una forma que todavía no se comprobó dejaría al validador
   * trabajando sobre una mentira del compilador.
   */
  private parse(rawBody: Buffer): unknown {
    try {
      return JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      // Firmado con nuestro secreto pero ilegible: no es un atacante, es un contrato roto.
      throw new BadRequestException('Cuerpo de webhook de Didit inválido');
    }
  }
}
