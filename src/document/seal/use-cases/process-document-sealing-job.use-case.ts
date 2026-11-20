import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DocumentSealingJobEntity } from '../entities/document-sealing-job.entity';
import { SealEntity } from '../entities/seal.entity';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  DocumentAlreadySealedException,
  DocumentSealingJobFailedException,
  IncompleteAdvancedSignatureEvidenceException,
  SealingJobLeaseLostException,
  SealingRequestSnapshotMismatchException,
  SealOperationInProgressException,
  SealPersistenceException,
  SealReconciliationRequiredException,
} from '../exceptions/seal.exceptions';
import { SEAL_OPERATION_STATUS_ENUM } from '../interfaces/seal-operation-response.interface';
import { SealedDocumentEvidenceRefresher } from '../interfaces/sealed-document-evidence-refresher.interface';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
} from '../interfaces/sealing-failure.interface';
import { SealingRequestSnapshotReference } from '../interfaces/sealing-request-snapshot.interface';
import { SealApiService } from '../services/seal-api.service';
import { SealingRequestSnapshotService } from '../services/sealing-request-snapshot.service';
import {
  classifySealingError,
  OCSP_UNKNOWN_MAX_ATTEMPTS,
  sealingFailure,
} from '../utils/classify-sealing-error.util';
import { RetryPendingSealUseCase } from './retry-pending-seal.use-case';
import { SealDocumentUseCase } from './seal-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './send-completed-simple-signature-to-seal.use-case';

/** Columnas del trabajo que el procesador escribe al avanzar de fase. */
type JobProgress = Partial<
  Pick<DocumentSealingJobEntity, 'phase' | 'requestObjectKey' | 'requestHash'>
>;

/**
 * Firmantes FIEL cuya evidencia OCSP no permite sellar todavía.
 *
 * **Política para `unknown`.** `unknown` significa que el respondedor del SAT no reconoce el
 * certificado: no prueba que esté vigente, así que nunca se trata como `good`. La evidencia se
 * conserva, el siguiente intento vuelve a preguntar y, tras `OCSP_UNKNOWN_MAX_ATTEMPTS`
 * ejecuciones, el trabajo queda `DEAD` (`OCSP_STATUS_UNKNOWN`).
 *
 * @param signers - Firmantes del documento, recargados después de completar el OCSP.
 * @returns Los ids de colaborador sin evidencia y los que tienen `unknown`.
 *
 * @example
 * ```ts
 * const { missing, unknown } = findUnsealableOcspSigners(signers);
 * ```
 */
export function findUnsealableOcspSigners(signers: CollaboratorEntity[]): {
  missing: string[];
  unknown: string[];
} {
  const missing: string[] = [];
  const unknown: string[] = [];

  for (const signer of signers) {
    if (signer.signatureType !== SIGNATURE_TYPE_ENUM.FIEL) {
      continue;
    }
    const evidence = signer.advancedSignature?.ocspEvidence;
    if (!evidence) {
      missing.push(signer.id);
    } else if (evidence.status !== 'good') {
      unknown.push(signer.id);
    }
  }

  return { missing, unknown };
}

/**
 * Procesa un trabajo de `document_sealing_jobs` ya reclamado, desde la evidencia OCSP faltante
 * hasta la constancia persistida y el PDF final con la hoja actualizada.
 *
 * **Retoma desde la fase guardada.** Cada fase deja su resultado en la base antes de avanzar:
 * - `VERIFYING_OCSP` (sólo avanzada): completa y guarda la evidencia de cada firmante, exige que
 *   sirva para sellar y congela el payload; avanza a `GENERATING_SEAL` con su referencia y hash.
 * - `GENERATING_SEAL`: envía el payload congelado a Seal Service con la clave idempotente del
 *   documento y guarda la constancia; avanza a `UPDATING_EVIDENCE_PDF`.
 * - `UPDATING_EVIDENCE_PDF`: regenera la hoja con la constancia desde el PDF firmado y publica el
 *   final; cierra el trabajo.
 *
 * Una constancia ya guardada en `document_seals` salta directo a `UPDATING_EVIDENCE_PDF`: nunca se
 * pide otro sello para un documento que ya lo tiene. Un fallo del PDF sólo repite esa fase.
 *
 * **Propiedad.** Cada escritura sobre el trabajo está condicionada a `status = PROCESSING` y al
 * `lease_token` recibido. Si otro worker lo recuperó, la escritura no toca ninguna fila y el
 * procesador lanza `SealingJobLeaseLostException` sin escribir nada más.
 *
 * **Errores tipados.** Cualquier otro fallo sale como `DocumentSealingJobFailedException`, con un
 * `SealingFailure` que dice si reintentar, conciliar o abandonar. Registrar ese fallo y
 * reprogramar el trabajo es tarea de `ProcessPendingSealingJobsJob` (con `SealingRetryPolicy`);
 * este caso de uso no toca `attempt_count`, `next_attempt_at` ni `status` salvo para completarlo.
 *
 * Nada de esto vuelve a firmar el documento ni toca `signed_hash`: el PDF firmado de
 * `signed_documents` sólo se lee.
 */
@Injectable()
export class ProcessDocumentSealingJobUseCase {
  private readonly logger = new Logger(ProcessDocumentSealingJobUseCase.name);
  private evidenceRefresher: SealedDocumentEvidenceRefresher | null = null;

  constructor(
    @InjectRepository(DocumentSealingJobEntity)
    private readonly jobRepository: Repository<DocumentSealingJobEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(SealEntity)
    private readonly sealRepository: Repository<SealEntity>,
    private readonly retryPendingSeal: RetryPendingSealUseCase,
    private readonly snapshots: SealingRequestSnapshotService,
    private readonly sealDocument: SealDocumentUseCase,
    private readonly sealSimpleSignatures: SendCompletedSimpleSignatureToSealUseCase,
    private readonly sealApi: SealApiService,
  ) {}

  /**
   * Registra quién regenera el PDF final. Lo llama `RefreshSealedDocumentEvidenceService` al
   * arrancar `DocumentModule` (ver `SealedDocumentEvidenceRefresher`).
   *
   * @param refresher - Implementación de la fase `UPDATING_EVIDENCE_PDF`.
   * @returns Nada.
   *
   * @example
   * ```ts
   * processor.useEvidenceRefresher(this);
   * ```
   */
  useEvidenceRefresher(refresher: SealedDocumentEvidenceRefresher): void {
    this.evidenceRefresher = refresher;
  }

  /**
   * Ejecuta las fases pendientes del trabajo.
   *
   * @param jobId - Trabajo reclamado.
   * @param leaseToken - Token del reclamo; debe seguir siendo el del trabajo.
   * @param ownership - Se aborta cuando el heartbeat pierde el lease (ver
   *   `SealingJobLeaseService.startHeartbeat`): no se empieza ninguna fase más.
   * @returns Nada, cuando el trabajo quedó `COMPLETED`.
   *
   * @throws {SealingJobLeaseLostException} Si el trabajo no existe, no está en `PROCESSING`, su
   *   token cambió o el reclamo venció. No se escribió nada desde que se perdió.
   * @throws {DocumentSealingJobFailedException} Si una fase falló; `failure` dice cómo seguir y la
   *   fase desde la que se retoma.
   *
   * @example
   * ```ts
   * try {
   *   await processor.execute(job.id, job.leaseToken!);
   * } catch (error) {
   *   if (error instanceof DocumentSealingJobFailedException) scheduleRetry(job, error.failure);
   * }
   * ```
   */
  async execute(
    jobId: string,
    leaseToken: string,
    ownership?: AbortSignal,
  ): Promise<void> {
    let job = await this.loadOwnedJob(jobId, leaseToken);
    const assertOwned = () => {
      if (ownership?.aborted) {
        throw new SealingJobLeaseLostException(jobId);
      }
    };

    try {
      const document = await this.documentRepository.findOne({
        where: { id: job.documentId },
      });
      if (!document || document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
        throw new DocumentSealingJobFailedException(
          sealingFailure(
            SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED,
            SEALING_FAILURE_CODE_ENUM.DOCUMENT_NOT_SIGNED,
            `El documento está en ${document?.status ?? 'ningún estado (no existe)'}, no en SIGNED.`,
            job.phase,
          ),
        );
      }

      let seal = await this.sealRepository.findOneBy({
        documentId: job.documentId,
      });

      // Una constancia existente nunca se vuelve a emitir: sólo falta el PDF.
      if (seal && job.phase !== SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF) {
        this.logger.log(
          `El documento ${job.documentId} ya tiene constancia; el trabajo ${job.id} pasa directo a actualizar el PDF.`,
        );
        job = await this.advance(job, leaseToken, {
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
        });
      }

      if (job.phase === SEALING_PHASE_ENUM.VERIFYING_OCSP) {
        assertOwned();
        job = await this.verifyOcsp(job, leaseToken);
      }

      if (job.phase === SEALING_PHASE_ENUM.GENERATING_SEAL) {
        assertOwned();
        seal = await this.generateSeal(job);
        assertOwned();
        job = await this.advance(job, leaseToken, {
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
        });
      }

      if (!seal) {
        throw new DocumentSealingJobFailedException(
          sealingFailure(
            SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED,
            SEALING_FAILURE_CODE_ENUM.SEAL_PERSISTENCE_FAILED,
            'El trabajo está en la fase del PDF, pero el documento no tiene constancia.',
            job.phase,
          ),
        );
      }

      assertOwned();
      await this.updateEvidencePdf(job, seal);
      assertOwned();
      await this.complete(job, leaseToken);
    } catch (error) {
      if (error instanceof SealingJobLeaseLostException) {
        throw error;
      }

      const failure = classifySealingError(error, job.phase);
      this.logger.warn(
        `El trabajo de sellado ${job.id} falló en ${failure.phase} (${failure.kind}, ${failure.code}).`,
      );
      throw new DocumentSealingJobFailedException(failure, { cause: error });
    }
  }

  /**
   * Fase `VERIFYING_OCSP`: completa la evidencia, exige que sirva y congela el payload avanzado.
   *
   * La evidencia de cada firmante se guarda en cuanto llega (ver `RetryPendingSealUseCase`), así
   * que un fallo a medias no repite las consultas que ya respondieron. El payload se congela con
   * los firmantes RECARGADOS: lo que se sella es exactamente lo que quedó en la base.
   *
   * @param job - Trabajo en `VERIFYING_OCSP`.
   * @param leaseToken - Token del reclamo.
   * @returns El trabajo en `GENERATING_SEAL`, con la referencia del payload.
   *
   * @throws {DocumentSealingJobFailedException} Si alguna evidencia es `unknown` (reintento acotado).
   * @throws {IncompleteAdvancedSignatureEvidenceException} Si un firmante sigue sin evidencia.
   * @throws {SealingJobLeaseLostException} Si se perdió el reclamo; el payload recién subido se borra.
   * @throws {Error} Los errores tipados de `RetryPendingSealUseCase` y del snapshot.
   *
   * @example
   * ```ts
   * job = await this.verifyOcsp(job, leaseToken);
   * ```
   */
  private async verifyOcsp(
    job: DocumentSealingJobEntity,
    leaseToken: string,
  ): Promise<DocumentSealingJobEntity> {
    // La firma simple no tiene OCSP; su payload ya viene congelado.
    if (job.sealType !== SEALING_TYPE_ENUM.ADVANCED) {
      return this.advance(job, leaseToken, {
        phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
      });
    }

    const signers = await this.retryPendingSeal.execute(job.documentId);

    const { missing, unknown } = findUnsealableOcspSigners(signers);
    if (missing.length > 0) {
      throw new IncompleteAdvancedSignatureEvidenceException(
        'la evidencia OCSP',
        missing[0],
      );
    }
    if (unknown.length > 0) {
      throw new DocumentSealingJobFailedException(
        sealingFailure(
          SEALING_FAILURE_KIND_ENUM.RETRYABLE,
          SEALING_FAILURE_CODE_ENUM.OCSP_STATUS_UNKNOWN,
          `El SAT respondió "unknown" para el certificado del firmante ${unknown[0]}; no se sella sin un estado "good".`,
          job.phase,
          { maxAttempts: OCSP_UNKNOWN_MAX_ATTEMPTS },
        ),
      );
    }

    const request: SealingRequestSnapshotReference =
      job.requestObjectKey && job.requestHash
        ? { objectKey: job.requestObjectKey, hash: job.requestHash }
        : await this.snapshots.freezeAdvancedSignatureRequest(job.documentId);

    try {
      return await this.advance(job, leaseToken, {
        phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
        requestObjectKey: request.objectKey,
        requestHash: request.hash,
      });
    } catch (error) {
      if (request.objectKey !== job.requestObjectKey) {
        await this.snapshots.discard(request.objectKey);
      }
      throw error;
    }
  }

  /**
   * Fase `GENERATING_SEAL`: lee el payload congelado y lo sella por el contrato del trabajo.
   *
   * En un reintento (`attempt_count > 1`) la ejecución anterior pudo dejar una solicitud en curso o
   * perder la respuesta, así que primero se consulta la operación idempotente: si Seal Service la
   * sigue emitiendo no se reenvía, y si requiere conciliación tampoco. En cualquier otro caso se
   * reenvía el mismo payload con la misma clave, que devuelve la evidencia ya emitida (con su
   * cadena canónica, que la consulta no trae) o emite por primera vez.
   *
   * @param job - Trabajo en `GENERATING_SEAL`.
   * @returns La constancia guardada (o la que ya estaba).
   *
   * @throws {SealingRequestSnapshotMismatchException} Si no hay payload o no corresponde al trabajo.
   * @throws {SealPersistenceException} Si la constancia no se pudo guardar.
   * @throws {SealOperationInProgressException} Si la consulta dice que sigue en proceso.
   * @throws {SealReconciliationRequiredException} Si la consulta dice que requiere conciliación.
   * @throws {Error} Los errores tipados de `SealApiService` y de MinIO.
   *
   * @example
   * ```ts
   * const seal = await this.generateSeal(job);
   * ```
   */
  private async generateSeal(
    job: DocumentSealingJobEntity,
  ): Promise<SealEntity> {
    if (!job.requestObjectKey || !job.requestHash) {
      throw new SealingRequestSnapshotMismatchException();
    }

    const snapshot = await this.snapshots.load({
      objectKey: job.requestObjectKey,
      hash: job.requestHash,
    });
    if (
      snapshot.documentId !== job.documentId ||
      snapshot.sealType !== job.sealType
    ) {
      throw new SealingRequestSnapshotMismatchException();
    }

    if (job.attemptCount > 1) {
      await this.assertNotInFlight(job.documentId);
    }

    if (snapshot.sealType === SEALING_TYPE_ENUM.SIMPLE) {
      return this.sealSimpleSignatures.execute(snapshot);
    }

    try {
      return await this.sealDocument.create(snapshot.request);
    } catch (error) {
      if (!(error instanceof DocumentAlreadySealedException)) {
        throw error;
      }
      // Otro intento guardó la constancia primero (violación de unicidad): se usa ésa.
      const existing = await this.sealDocument.findByDocumentId(job.documentId);
      if (!existing) {
        throw new SealPersistenceException();
      }
      return existing;
    }
  }

  /**
   * Consulta la operación idempotente del documento antes de reenviarla.
   *
   * @param documentId - Documento.
   * @returns Nada si se puede reenviar (`NOT_FOUND`, `FAILED` o `COMPLETED`).
   *
   * @throws {SealOperationInProgressException} Si sigue en `PROCESSING`.
   * @throws {SealReconciliationRequiredException} Si está en `RECONCILIATION_REQUIRED`.
   * @throws {Error} Los errores de transporte de la consulta (reintentables).
   *
   * @example
   * ```ts
   * await this.assertNotInFlight(job.documentId);
   * ```
   */
  private async assertNotInFlight(documentId: string): Promise<void> {
    const operation = await this.sealApi.getSealOperation(documentId);

    if (operation.status === SEAL_OPERATION_STATUS_ENUM.PROCESSING) {
      throw new SealOperationInProgressException();
    }
    if (
      operation.status === SEAL_OPERATION_STATUS_ENUM.RECONCILIATION_REQUIRED
    ) {
      throw new SealReconciliationRequiredException(
        operation.error?.code ?? null,
      );
    }
  }

  /**
   * Fase `UPDATING_EVIDENCE_PDF`: delega en el puerto registrado por `DocumentModule`.
   *
   * @param job - Trabajo en `UPDATING_EVIDENCE_PDF`.
   * @param seal - Constancia persistida.
   * @returns Nada, cuando el PDF final está publicado.
   *
   * @throws {Error} Si no hay implementación registrada, o los errores del puerto.
   *
   * @example
   * ```ts
   * await this.updateEvidencePdf(job, seal);
   * ```
   */
  private async updateEvidencePdf(
    job: DocumentSealingJobEntity,
    seal: SealEntity,
  ): Promise<void> {
    if (!this.evidenceRefresher) {
      throw new Error(
        'No hay un SealedDocumentEvidenceRefresher registrado para actualizar el PDF final.',
      );
    }
    await this.evidenceRefresher.refresh(job.documentId, seal);
  }

  /**
   * Cierra el trabajo y limpia la marca de pendiente del documento, en UNA transacción
   * condicionada al reclamo.
   *
   * Si el proceso cae después de publicar el PDF y antes de confirmar, el trabajo sigue en
   * `UPDATING_EVIDENCE_PDF` y el siguiente intento vuelve a generar la hoja desde el mismo PDF
   * firmado: el resultado es el mismo archivo, sin hojas acumuladas.
   *
   * @param job - Trabajo con el PDF ya publicado.
   * @param leaseToken - Token del reclamo.
   * @returns Nada.
   *
   * @throws {SealingJobLeaseLostException} Si se perdió el reclamo; la transacción se revierte.
   *
   * @example
   * ```ts
   * await this.complete(job, leaseToken);
   * ```
   */
  private async complete(
    job: DocumentSealingJobEntity,
    leaseToken: string,
  ): Promise<void> {
    await this.jobRepository.manager.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(DocumentSealingJobEntity)
        .set({
          status: SEALING_JOB_STATUS_ENUM.COMPLETED,
          completedAt: () => 'now()',
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastUpstreamStatus: null,
        })
        .where('id = :id', { id: job.id })
        .andWhere('status = :status', {
          status: SEALING_JOB_STATUS_ENUM.PROCESSING,
        })
        .andWhere('lease_token = :leaseToken', { leaseToken })
        .execute();

      if (!result.affected) {
        throw new SealingJobLeaseLostException(job.id);
      }

      await manager.update(
        DocumentEntity,
        { id: job.documentId },
        { sealingPendingAt: null },
      );
    });

    this.logger.log(
      `Trabajo de sellado ${job.id} completado: el documento ${job.documentId} tiene constancia y PDF final actualizado.`,
    );
  }

  /**
   * Guarda el avance de fase sólo si el trabajo sigue en `PROCESSING` con este reclamo.
   *
   * @param job - Trabajo actual.
   * @param leaseToken - Token del reclamo.
   * @param progress - Fase y, si aplica, referencia del payload.
   * @returns El trabajo con los cambios aplicados.
   *
   * @throws {SealingJobLeaseLostException} Si ninguna fila cumplió la condición.
   *
   * @example
   * ```ts
   * job = await this.advance(job, leaseToken, { phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF });
   * ```
   */
  private async advance(
    job: DocumentSealingJobEntity,
    leaseToken: string,
    progress: JobProgress,
  ): Promise<DocumentSealingJobEntity> {
    const result = await this.jobRepository
      .createQueryBuilder()
      .update(DocumentSealingJobEntity)
      .set(progress)
      .where('id = :id', { id: job.id })
      .andWhere('status = :status', {
        status: SEALING_JOB_STATUS_ENUM.PROCESSING,
      })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    if (!result.affected) {
      throw new SealingJobLeaseLostException(job.id);
    }

    return { ...job, ...progress } as DocumentSealingJobEntity;
  }

  /**
   * Lee el trabajo y comprueba que siga reclamado por quien llama.
   *
   * @param jobId - Trabajo.
   * @param leaseToken - Token del reclamo.
   * @returns El trabajo.
   *
   * @throws {SealingJobLeaseLostException} Si no existe, no está en `PROCESSING`, el token no
   *   coincide o el reclamo venció.
   *
   * @example
   * ```ts
   * const job = await this.loadOwnedJob(jobId, leaseToken);
   * ```
   */
  private async loadOwnedJob(
    jobId: string,
    leaseToken: string,
  ): Promise<DocumentSealingJobEntity> {
    const job = await this.jobRepository.findOneBy({ id: jobId });

    const owned =
      job !== null &&
      job.status === SEALING_JOB_STATUS_ENUM.PROCESSING &&
      job.leaseToken === leaseToken &&
      job.leaseExpiresAt !== null &&
      new Date(job.leaseExpiresAt).getTime() > Date.now();

    if (!owned) {
      throw new SealingJobLeaseLostException(jobId);
    }

    return job;
  }
}
