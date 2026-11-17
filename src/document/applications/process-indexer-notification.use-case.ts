import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DocumentIndexingJobEntity } from '../entities/document-indexing-job.entity';
import {
  DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE,
  DOCUMENT_INDEXING_STATUS_ENUM,
  IndexerProviderState,
} from '../enum/document-indexing-status.enum';

/** Lo que el indexador notificó sobre un documento, ya autenticado y validado. */
export interface IndexerNotification {
  jobId: string;
  /** El `documentId` del indexador. Se guarda, pero no identifica nada local. */
  externalDocumentId: string;
  /** `DocumentEntity.id`: la llave con la que se localiza el job. */
  clientDocumentId: string;
  state: IndexerProviderState;
  duplicate?: boolean;
  error?: unknown;
}

const UNKNOWN_FAILURE = 'El indexador reportó un fallo sin detalle';

/**
 * A qué estados puede pasar un job. Los webhooks no garantizan orden, así que un `PENDING` admite un
 * resultado final sin haber visto `received`; un job finalizado no admite nada.
 */
const ALLOWED_TRANSITIONS: Record<
  DOCUMENT_INDEXING_STATUS_ENUM,
  DOCUMENT_INDEXING_STATUS_ENUM[]
> = {
  [DOCUMENT_INDEXING_STATUS_ENUM.PENDING]: [
    DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
    DOCUMENT_INDEXING_STATUS_ENUM.INDEXED,
    DOCUMENT_INDEXING_STATUS_ENUM.FAILED,
  ],
  [DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED]: [
    DOCUMENT_INDEXING_STATUS_ENUM.INDEXED,
    DOCUMENT_INDEXING_STATUS_ENUM.FAILED,
  ],
  [DOCUMENT_INDEXING_STATUS_ENUM.INDEXED]: [],
  [DOCUMENT_INDEXING_STATUS_ENUM.FAILED]: [],
};

/**
 * Aplica una notificación del indexador al `DocumentIndexingJobEntity` del documento.
 *
 * El contrato identifica el documento y no el job: la correlación se apoya en que sólo puede haber un
 * job activo por documento (`UQ_document_indexing_jobs_active`). Si algún día se permiten
 * reindexaciones simultáneas, el evento y el webhook tendrán que incluir un `clientJobId`.
 */
@Injectable()
export class ProcessIndexerNotificationUseCase {
  private readonly logger = new Logger(ProcessIndexerNotificationUseCase.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Bloquea el job más reciente del documento y le aplica la notificación si la transición es válida.
   * El bloqueo evita que un `received` tardío, procesado en paralelo, pise a un `indexed`.
   *
   * @param notification - Notificación del indexador.
   * @returns `true` si cambió el job; `false` si ya estaba aplicada o el job está finalizado.
   *
   * @throws {NotFoundException} Si el documento no tiene ningún job.
   * @throws {ConflictException} Si el job ya está asociado a otro `jobId`.
   *
   * @example
   * ```ts
   * await useCase.execute({
   *   jobId: '9f2c...', externalDocumentId: '3fa8...', clientDocumentId: document.id,
   *   state: 'received', duplicate: true,
   * }); // true
   * ```
   */
  async execute(notification: IndexerNotification): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(DocumentIndexingJobEntity);

      const job = await repository.findOne({
        where: { documentId: notification.clientDocumentId },
        order: { createdAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });

      if (!job) {
        throw new NotFoundException(
          `El documento ${notification.clientDocumentId} no tiene un trabajo de indexación`,
        );
      }

      if (job.externalJobId && job.externalJobId !== notification.jobId) {
        throw new ConflictException(
          `El trabajo ${job.id} ya está asociado a otro jobId del indexador`,
        );
      }

      const status =
        DOCUMENT_INDEXING_STATUS_BY_PROVIDER_STATE[notification.state];

      if (!ALLOWED_TRANSITIONS[job.status].includes(status)) {
        this.logger.log(
          `Notificación ${notification.state} ignorada: el trabajo ${job.id} ya está en ${job.status}.`,
        );
        return false;
      }

      await repository.save(this.apply(job, notification, status));
      return true;
    });
  }

  private apply(
    job: DocumentIndexingJobEntity,
    notification: IndexerNotification,
    status: DOCUMENT_INDEXING_STATUS_ENUM,
  ): DocumentIndexingJobEntity {
    const now = new Date();
    const previous = job.metadata?.response as
      | { duplicate?: boolean }
      | undefined;

    job.status = status;
    // Fuera del estado `received` también: si ese webhook se perdió, el job igual queda identificado.
    job.externalJobId = job.externalJobId ?? notification.jobId;
    job.externalDocumentId =
      job.externalDocumentId ?? notification.externalDocumentId;
    // Se agrega a la copia de la solicitud que ya vive en `metadata`, sin reemplazarla.
    job.metadata = {
      ...job.metadata,
      response: {
        providerState: notification.state,
        duplicate: notification.duplicate ?? previous?.duplicate ?? false,
        receivedAt: now.toISOString(),
      },
    };

    if (status === DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED) {
      job.receivedAt = now;
    } else {
      job.completedAt = now;
      job.error =
        status === DOCUMENT_INDEXING_STATUS_ENUM.FAILED
          ? this.describeFailure(notification.error)
          : null;
    }

    return job;
  }

  private describeFailure(error: unknown): string {
    return typeof error === 'string' && error ? error : UNKNOWN_FAILURE;
  }
}
