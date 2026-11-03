import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ProcessIndexerNotificationUseCase } from 'src/document/applications/process-indexer-notification.use-case';
import { IndexerWebhookSignatureVerifierService } from '../indexer/indexer-webhook-signature-verifier.service';
import { validateIndexerWebhookPayload } from '../indexer/indexer-webhook-payload.schema';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';

interface ReceiveIndexerWebhookInput {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Orquesta una entrega del indexador: autenticar → validar la forma → registrar → delegar → cerrar
 * el estado. Lo que significa cada estado vive en `ProcessIndexerNotificationUseCase`.
 */
@Injectable()
export class ReceiveIndexerWebhookUseCase {
  private readonly logger = new Logger(ReceiveIndexerWebhookUseCase.name);

  constructor(
    private readonly signatureVerifier: IndexerWebhookSignatureVerifierService,
    private readonly registerWebhookEvent: RegisterWebhookEventUseCase,
    private readonly processIndexerNotification: ProcessIndexerNotificationUseCase,
  ) {}

  /**
   * Procesa una entrega y deja constancia en `webhook_events`, incluso si se rechaza.
   *
   * @param input - Cuerpo crudo y cabeceras de firma.
   * @returns `duplicate: true` si la entrega ya estaba aplicada y no cambió nada.
   *
   * @throws {UnauthorizedException} Si la firma es inválida, falta o expiró.
   * @throws {BadRequestException} Si el cuerpo auténtico no cumple el contrato.
   * @throws {NotFoundException} Si el documento no tiene un job con el que correlacionar.
   * @throws {ConflictException} Si el job ya está asociado a otro `jobId`.
   *
   * @example
   * ```ts
   * await useCase.execute({ rawBody, signature, timestamp });
   * // { received: true, duplicate: false }
   * ```
   */
  async execute(
    input: ReceiveIndexerWebhookInput,
  ): Promise<WebhookReceptionResult> {
    // Primero la firma: un POST falso no puede mover un job ni sembrar datos en `webhook_events`.
    const isAuthentic = this.signatureVerifier.verify(
      input.rawBody,
      input.signature,
      input.timestamp,
    );

    if (!isAuthentic) {
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.INDEXER,
        'Firma HMAC del indexador inválida, ausente o expirada',
      );
      throw new UnauthorizedException('Firma del indexador inválida');
    }

    const validation = validateIndexerWebhookPayload(this.parse(input.rawBody));

    if (validation.reason) {
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.INDEXER,
        `Payload del indexador inválido: ${validation.reason}`,
        { signatureValid: true, eventType: 'invalid_payload' },
      );
      this.logger.warn(`Payload del indexador inválido: ${validation.reason}`);
      throw new BadRequestException(
        'Payload de webhook del indexador inválido',
      );
    }

    const { payload } = validation;

    const { event, alreadyProcessed } =
      await this.registerWebhookEvent.register({
        provider: WEBHOOK_PROVIDER_ENUM.INDEXER,
        /**
         * El indexador no manda un id de entrega, así que la clave es lo que la define. Lleva el
         * documento además del job y el estado porque `jobId` tiene forma de hash: si el indexador
         * lo deriva del contenido, un `duplicate: true` de OTRO documento repetiría job y estado, y
         * descartarlo como reentrega dejaría a ese documento sin actualizar.
         */
        providerEventId: `${payload.jobId}:${payload.clientDocumentId}:${payload.state}`,
        providerResourceId: payload.jobId,
        eventType: payload.state,
        payload,
      });

    if (alreadyProcessed) {
      return { received: true, duplicate: true };
    }

    try {
      const applied = await this.processIndexerNotification.execute({
        jobId: payload.jobId,
        externalDocumentId: payload.documentId,
        clientDocumentId: payload.clientDocumentId,
        state: payload.state,
        duplicate: payload.duplicate,
        error: payload.error,
      });

      await this.registerWebhookEvent.markProcessed(event.id);
      return { received: true, duplicate: !applied };
    } catch (error) {
      await this.registerWebhookEvent.markFailed(event.id, error);
      this.logger.error(
        `Falló el procesamiento del webhook del indexador ${event.providerEventId ?? event.id}.`,
        error instanceof Error ? error.stack : undefined,
      );
      // Se propaga para que el indexador vea el error; una reentrega vuelve a intentarlo porque la
      // fila queda en FAILED, no en PROCESSED.
      throw error;
    }
  }

  /** Un cuerpo que no es JSON devuelve `null` para que el validador lo rechace y quede auditado. */
  private parse(rawBody: Buffer): unknown {
    try {
      return JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }
}
