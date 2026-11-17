import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { DiditWebhookSignatureVerifierService } from '../didit/didit-webhook-signature-verifier.service';
import { validateDiditWebhookPayload } from '../didit/didit-webhook-payload.schema';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import {
  DiditWebhookDispatcherService,
  DiditWebhookRoute,
} from '../didit/didit-webhook-dispatcher.service';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';
import {
  WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE,
  WEBHOOK_UNVERIFIED_EVENT_TYPE,
  WebhookDeliveryOutcome,
  WebhookMetricsService,
} from 'src/metrics/webhook-metrics.service';

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
 * procesado. El significado del resultado vive en cada dominio: `DiditWebhookDispatcherService`
 * lo entrega a `ProcessDiditVerificationResultUseCase` o a `ProcessBiometricSignatureResultUseCase`.
 */
@Injectable()
export class ReceiveDiditWebhookUseCase {
  private readonly logger = new Logger(ReceiveDiditWebhookUseCase.name);

  constructor(
    private readonly signatureVerifier: DiditWebhookSignatureVerifierService,
    private readonly registerWebhookEvent: RegisterWebhookEventUseCase,
    /**
     * Decide si la entrega es de una firma biométrica o de una verificación de identidad (por el
     * `session_id`) y la entrega a ese dominio. Este caso de uso sólo autentica y registra.
     */
    private readonly dispatcher: DiditWebhookDispatcherService,
    private readonly webhookMetrics: WebhookMetricsService,
  ) {}

  /**
   * Atiende una entrega de Didit y registra su resultado en las métricas.
   *
   * Una entrega que el dispatcher ignora se marca PROCESSED y responde 200: fue autenticada y
   * descartada a propósito, así que no debe reintentarse. En las métricas queda como `ignored`.
   *
   * @param input - Cuerpo crudo, firma y timestamp de la entrega.
   * @returns El acuse para Didit, indicando si era un duplicado.
   *
   * @throws {UnauthorizedException} Si la firma no verifica.
   * @throws {BadRequestException} Si el cuerpo firmado es ilegible o incumple el contrato.
   * @throws {Error} Lo que lance el dominio o la base, para responder 5xx y que Didit reintente.
   *
   * @example
   * ```ts
   * await useCase.execute({ rawBody, signature, timestamp });
   * ```
   */
  async execute(
    input: ReceiveDiditWebhookInput,
  ): Promise<WebhookReceptionResult> {
    const startedAt = performance.now();
    let eventType = WEBHOOK_UNVERIFIED_EVENT_TYPE;
    // `failed` hasta demostrar lo contrario: así un error de la base al registrar o al cerrar el
    // estado, que también responde 5xx, cuenta como fallo sin necesidad de un `catch` por paso.
    let outcome: WebhookDeliveryOutcome = 'failed';

    try {
      // Primero la firma, antes de mirar una sola propiedad del cuerpo: un POST falso no puede
      // aprobar una identidad, y tampoco puede sembrar datos en `webhook_events`.
      const isAuthentic = this.signatureVerifier.verify(
        input.rawBody,
        input.signature,
        input.timestamp,
      );
      this.webhookMetrics.recordSignatureVerification(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        isAuthentic,
      );

      if (!isAuthentic) {
        outcome = 'rejected';
        await this.registerWebhookEvent.recordRejectedDelivery(
          WEBHOOK_PROVIDER_ENUM.DIDIT,
          'Firma HMAC de Didit inválida, ausente o expirada',
        );
        throw new UnauthorizedException('Firma de Didit inválida');
      }

      // Desde aquí y hasta validar el cuerpo, salir por excepción es un rechazo de contrato.
      eventType = WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE;
      outcome = 'rejected';

      const payload = await this.parse(input.rawBody);
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
          {
            signatureValid: true,
            eventType: WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE,
          },
        );
        this.logger.warn(`Payload de Didit inválido: ${validation.reason}`);
        throw new BadRequestException('Payload de webhook de Didit inválido');
      }

      eventType = validation.payload.webhook_type;
      outcome = 'failed';

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
        outcome = 'duplicate';
        return { received: true, duplicate: true };
      }

      let route: DiditWebhookRoute;

      try {
        route = await this.dispatcher.dispatch(validation.payload);
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

      this.webhookMetrics.recordDispatch(WEBHOOK_PROVIDER_ENUM.DIDIT, route);

      await this.registerWebhookEvent.markProcessed(event.id);
      outcome = route === 'ignored' ? 'ignored' : 'processed';
      return { received: true, duplicate: false };
    } finally {
      this.webhookMetrics.recordDelivery({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        eventType,
        outcome,
        durationSeconds: (performance.now() - startedAt) / 1000,
      });
    }
  }

  /**
   * Interpreta el cuerpo firmado como JSON y, si es ilegible, deja constancia y lo rechaza.
   *
   * Devuelve `unknown` a propósito: lo único que garantiza `JSON.parse` es que el texto era JSON,
   * no que sea un objeto. Afirmar acá una forma que todavía no se comprobó dejaría al validador
   * trabajando sobre una mentira del compilador.
   *
   * @param rawBody - Cuerpo crudo, con la firma ya verificada.
   * @returns El JSON sin validar.
   *
   * @throws {BadRequestException} Si no es JSON legible.
   *
   * @example
   * ```ts
   * const payload = await this.parse(input.rawBody);
   * ```
   */
  private async parse(rawBody: Buffer): Promise<unknown> {
    try {
      return JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      // Firmado con nuestro secreto pero ilegible: no es un atacante, es un contrato roto. El
      // motivo es fijo: el mensaje de `JSON.parse` cita fragmentos del cuerpo.
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        'Cuerpo de Didit ilegible: no es JSON',
        {
          signatureValid: true,
          eventType: WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE,
        },
      );
      this.logger.warn('Cuerpo de Didit firmado pero ilegible.');
      throw new BadRequestException('Cuerpo de webhook de Didit inválido');
    }
  }
}
