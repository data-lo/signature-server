import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { DocumentSealingJobEntity } from '../entities/document-sealing-job.entity';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import { SealingRequestSnapshotReference } from '../interfaces/sealing-request-snapshot.interface';

/**
 * Por qué un trabajo nace sin poder ejecutarse: falta evidencia que ningún reintento va a
 * conseguir, así que queda en `RECONCILIATION_REQUIRED` para que lo revise una persona.
 */
export interface SealingJobBlocker {
  /** Código normalizado, por ejemplo `SIMPLE_EVIDENCE_INCOMPLETE`. */
  code: string;
  /** Diagnóstico sanitizado: sin datos personales ni códigos de verificación. */
  message: string;
}

/** Lo que se registra al cerrar un documento. */
export interface RegisterDocumentSealingJobInput {
  documentId: string;
  sealType: SEALING_TYPE_ENUM;
  /** Payload ya congelado; `null` si se congela después (firma avanzada, tras el OCSP). */
  request?: SealingRequestSnapshotReference | null;
  /** Si viene, el trabajo nace bloqueado en `RECONCILIATION_REQUIRED`. */
  blocker?: SealingJobBlocker | null;
}

/** Resultado del registro. */
export interface RegisterDocumentSealingJobResult {
  job: DocumentSealingJobEntity;
  /** `false` si ya existía un trabajo para el documento y se devolvió ése, sin tocarlo. */
  created: boolean;
}

/**
 * Registra el trabajo de sellado de un documento DENTRO de la transacción que lo cierra.
 *
 * Recibe el `EntityManager` de esa transacción a propósito: el trabajo, el documento en `SIGNED`,
 * la evidencia del último firmante y el consumo de reservas se confirman o se revierten juntos. Un
 * rollback no deja un trabajo ejecutable de un cierre que no ocurrió, y un cierre confirmado
 * siempre tiene su trabajo.
 *
 * **Idempotente por documento.** El `INSERT` hace `ON CONFLICT DO NOTHING` contra
 * `UQ_document_sealing_jobs_document_id` y, si ya había un trabajo, lo relee y lo devuelve sin
 * modificarlo: no reinicia sus intentos, no reabre uno `COMPLETED` ni `DEAD`, y no cambia su
 * payload. Dos cierres concurrentes del mismo documento se resuelven en la base: el segundo
 * `INSERT` espera a que el primero confirme y entonces no inserta nada.
 *
 * La fase inicial depende del contrato: la firma avanzada empieza por `VERIFYING_OCSP` (su payload
 * se congela después de completar la evidencia de revocación) y la simple por `GENERATING_SEAL`
 * (su payload ya viene congelado).
 */
@Injectable()
export class RegisterDocumentSealingJobUseCase {
  private readonly logger = new Logger(RegisterDocumentSealingJobUseCase.name);

  /**
   * Inserta el trabajo o devuelve el existente.
   *
   * @param input - Documento, contrato, payload congelado y, si aplica, el motivo de bloqueo.
   * @param manager - `EntityManager` de la transacción de cierre del documento.
   * @returns El trabajo del documento y si se acaba de crear.
   *
   * @throws {EntityNotFoundError} Si el `INSERT` no insertó y tampoco existe un trabajo (no debería
   *   pasar: sólo ocurre si otra restricción ignoró la fila).
   * @throws {QueryFailedError} Si el documento no existe o la base rechaza la fila.
   *
   * @example
   * ```ts
   * await dataSource.transaction(async (manager) => {
   *   const { job } = await registerSealingJob.execute(
   *     { documentId, sealType: SEALING_TYPE_ENUM.SIMPLE, request: reference },
   *     manager,
   *   );
   * });
   * ```
   */
  async execute(
    input: RegisterDocumentSealingJobInput,
    manager: EntityManager,
  ): Promise<RegisterDocumentSealingJobResult> {
    const insert = await manager
      .createQueryBuilder()
      .insert()
      .into(DocumentSealingJobEntity)
      .values({
        documentId: input.documentId,
        sealType: input.sealType,
        status: input.blocker
          ? SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED
          : SEALING_JOB_STATUS_ENUM.PENDING,
        phase: initialPhase(input.sealType),
        attemptCount: 0,
        requestObjectKey: input.request?.objectKey ?? null,
        requestHash: input.request?.hash ?? null,
        lastErrorCode: input.blocker?.code ?? null,
        lastErrorMessage: input.blocker?.message ?? null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();

    const created = insert.raw.length > 0;
    const job = await manager
      .getRepository(DocumentSealingJobEntity)
      .findOneByOrFail({ documentId: input.documentId });

    if (!created) {
      this.logger.log(
        `El documento ${input.documentId} ya tenía un trabajo de sellado (${job.id}, ${job.status}); se conserva.`,
      );
    }

    return { job, created };
  }
}

/**
 * Primera fase de un trabajo según su contrato.
 *
 * @param sealType - Contrato de sellado.
 * @returns `VERIFYING_OCSP` para la firma avanzada; `GENERATING_SEAL` para la simple.
 *
 * @example
 * ```ts
 * initialPhase(SEALING_TYPE_ENUM.ADVANCED); // SEALING_PHASE_ENUM.VERIFYING_OCSP
 * ```
 */
export function initialPhase(sealType: SEALING_TYPE_ENUM): SEALING_PHASE_ENUM {
  return sealType === SEALING_TYPE_ENUM.ADVANCED
    ? SEALING_PHASE_ENUM.VERIFYING_OCSP
    : SEALING_PHASE_ENUM.GENERATING_SEAL;
}
