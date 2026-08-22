import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { WebhookEventEntity } from '../entities/webhook-event.entity';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from '../enums/webhook-processing-status.enum';

const UNIQUE_VIOLATION = '23505';

interface RegisterWebhookEventInput {
  provider: WEBHOOK_PROVIDER_ENUM;
  providerEventId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

interface RegisterWebhookEventResult {
  event: WebhookEventEntity;
  /**
   * `true` si esta entrega ya se procesó con éxito antes. El caso de uso que llama debe
   * responder 200 sin tocar el dominio.
   */
  alreadyProcessed: boolean;
}

/**
 * Dueño único de la tabla `webhook_events`: registrar la entrega, decidir si es un duplicado
 * ya procesado y mover el estado a PROCESSED/FAILED.
 *
 * Ningún caso de uso de dominio toca esta tabla, y este caso de uso no sabe nada de identidad
 * ni de pagos — sólo del ciclo de vida de una entrega HTTP.
 */
@Injectable()
export class RegisterWebhookEventUseCase {
  private readonly logger = new Logger(RegisterWebhookEventUseCase.name);

  constructor(
    @InjectRepository(WebhookEventEntity)
    private readonly webhookEventRepository: Repository<WebhookEventEntity>,
  ) {}

  /**
   * Registra una entrega con firma válida y responde si ya había sido procesada.
   *
   * Una fila preexistente en RECEIVED o FAILED **no** cuenta como duplicado procesado: significa
   * que el intento anterior no llegó a completar el dominio (error transitorio, o el proveedor
   * cortó la conexión). Los dos proveedores reenvían justamente en ese caso, así que tratar esa
   * re-entrega como duplicado dejaría el evento muerto para siempre. Sólo PROCESSED corta el
   * flujo — que es la garantía que importa: las reglas de negocio no corren dos veces.
   */
  async register(
    input: RegisterWebhookEventInput,
  ): Promise<RegisterWebhookEventResult> {
    const existing = await this.findByProviderEvent(
      input.provider,
      input.providerEventId,
    );

    if (existing) {
      if (
        existing.processingStatus === WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED
      ) {
        this.logger.log(
          `Entrega duplicada de ${input.provider} (${input.providerEventId}): ya procesada, no se vuelve a ejecutar el dominio.`,
        );
        return { event: existing, alreadyProcessed: true };
      }

      await this.webhookEventRepository.update(existing.id, {
        eventType: input.eventType,
        signatureValid: true,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
        payload: input.payload,
        receivedAt: new Date(),
        processedAt: null,
        error: null,
      });

      return {
        event: await this.webhookEventRepository.findOneBy({ id: existing.id }),
        alreadyProcessed: false,
      };
    }

    try {
      const created = this.webhookEventRepository.create({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        signatureValid: true,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
        payload: input.payload,
        receivedAt: new Date(),
      });

      return {
        event: await this.webhookEventRepository.save(created),
        alreadyProcessed: false,
      };
    } catch (error) {
      /**
       * Carrera real, no defensa teórica: los proveedores reenvían en paralelo cuando la
       * primera entrega tarda, y ambas peticiones pueden pasar el `findByProviderEvent` antes
       * de que cualquiera inserte. El índice único es quien decide; el perdedor relee la fila
       * del ganador y la trata como duplicado en vez de reventar con un 500.
       */
      if (this.isUniqueViolation(error)) {
        const winner = await this.findByProviderEvent(
          input.provider,
          input.providerEventId,
        );

        if (winner) {
          return { event: winner, alreadyProcessed: true };
        }
      }

      throw error;
    }
  }

  /**
   * Deja constancia de un intento con firma inválida.
   *
   * Sin `provider_event_id` ni `payload`: el cuerpo no es confiable, así que no se almacena ni
   * se lee para extraer identificadores. Queda sólo lo que sí sabemos de primera mano — quién
   * decía ser, cuándo llegó y que la firma no verificó.
   */
  async recordRejectedDelivery(
    provider: WEBHOOK_PROVIDER_ENUM,
    reason: string,
  ): Promise<void> {
    try {
      await this.webhookEventRepository.save(
        this.webhookEventRepository.create({
          provider,
          providerEventId: null,
          eventType: 'unverified',
          signatureValid: false,
          processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
          payload: null,
          receivedAt: new Date(),
          error: reason,
        }),
      );
    } catch (error) {
      // La auditoría no puede convertir un 401 en un 500: si falla, se registra y se sigue.
      this.logger.error(
        `No se pudo auditar una entrega rechazada de ${provider}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.webhookEventRepository.update(eventId, {
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
      processedAt: new Date(),
      error: null,
    });
  }

  async markFailed(eventId: string, error: unknown): Promise<void> {
    await this.webhookEventRepository.update(eventId, {
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      processedAt: new Date(),
      error: this.describe(error),
    });
  }

  private findByProviderEvent(
    provider: WEBHOOK_PROVIDER_ENUM,
    providerEventId: string | null,
  ): Promise<WebhookEventEntity | null> {
    // Sin identificador no hay clave de idempotencia posible: cada entrega es una fila nueva.
    if (!providerEventId) {
      return Promise.resolve(null);
    }

    return this.webhookEventRepository.findOne({
      where: { provider, providerEventId },
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION
    );
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    return String(error);
  }
}
