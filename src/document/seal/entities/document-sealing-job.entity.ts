import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { DocumentEntity } from '../../entities/document.entity';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';

/** Nombres de las restricciones e índices, compartidos con `CreateDocumentSealingJobs1784300000099`. */
export const DOCUMENT_SEALING_JOB_CONSTRAINTS = {
  primaryKey: 'PK_document_sealing_jobs',
  documentForeignKey: 'FK_document_sealing_jobs_document_id',
  uniqueDocument: 'UQ_document_sealing_jobs_document_id',
  attemptCount: 'CHK_document_sealing_jobs_attempt_count',
  status: 'CHK_document_sealing_jobs_status',
  phase: 'CHK_document_sealing_jobs_phase',
  sealType: 'CHK_document_sealing_jobs_seal_type',
  claimableIndex: 'IDX_document_sealing_jobs_claimable',
  expiredLeaseIndex: 'IDX_document_sealing_jobs_expired_lease',
} as const;

/**
 * Lista SQL de los valores de un enum, para los `CHECK`.
 *
 * @param values - Valores del enum.
 * @returns `'A', 'B'`, listo para `IN (...)`.
 *
 * @example
 * ```ts
 * sqlValues(['ADVANCED', 'SIMPLE']); // "'ADVANCED', 'SIMPLE'"
 * ```
 */
export function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Trabajo persistente de sellado de un documento firmado: un solo trabajo por documento, que un
 * worker ejecuta fuera de la petición de firma.
 *
 * Se registra en la MISMA transacción que deja el documento en `SIGNED` (ver
 * `RegisterDocumentSealingJobUseCase` y `DocumentService.finalizeSignedDocument`), así que no existe
 * un documento cerrado sin su trabajo ni un trabajo de un cierre que se revirtió. Sobrevive a
 * reinicios del servidor y a caídas del SAT o de Seal Service: el sellado ya no depende de que
 * respondan durante la firma.
 *
 * Lo que el worker necesita y no está aquí:
 * - El payload que se envía al proveedor vive en el bucket privado `sealing-requests`, en
 *   `requestObjectKey`. Esta tabla no copia identidades, códigos ni imágenes.
 * - La evidencia de cada firmante sigue en `collaborators` (firma avanzada, snapshot de la rúbrica).
 *
 * Restricciones (`CreateDocumentSealingJobs1784300000099`):
 * - `UQ_document_sealing_jobs_document_id`: un trabajo por documento.
 * - `CHK_document_sealing_jobs_attempt_count`: `attempt_count >= 0`.
 * - `CHK_document_sealing_jobs_status`, `_phase` y `_seal_type`: sólo los valores de sus enums.
 * - `IDX_document_sealing_jobs_claimable`: trabajos `PENDING` y `RETRY_SCHEDULED` por
 *   `next_attempt_at`, la consulta con la que el worker busca qué ejecutar.
 * - `IDX_document_sealing_jobs_expired_lease`: trabajos `PROCESSING` por `lease_expires_at`, para
 *   recuperar los de un worker que murió a mitad de un intento.
 */
@Entity('document_sealing_jobs')
@Unique(DOCUMENT_SEALING_JOB_CONSTRAINTS.uniqueDocument, ['documentId'])
@Index(DOCUMENT_SEALING_JOB_CONSTRAINTS.claimableIndex, ['nextAttemptAt'], {
  where: `"status" IN ('${SEALING_JOB_STATUS_ENUM.PENDING}', '${SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED}')`,
})
@Index(DOCUMENT_SEALING_JOB_CONSTRAINTS.expiredLeaseIndex, ['leaseExpiresAt'], {
  where: `"status" = '${SEALING_JOB_STATUS_ENUM.PROCESSING}'`,
})
@Check(DOCUMENT_SEALING_JOB_CONSTRAINTS.attemptCount, `"attempt_count" >= 0`)
@Check(
  DOCUMENT_SEALING_JOB_CONSTRAINTS.status,
  `"status" IN (${sqlValues(Object.values(SEALING_JOB_STATUS_ENUM))})`,
)
@Check(
  DOCUMENT_SEALING_JOB_CONSTRAINTS.phase,
  `"phase" IN (${sqlValues(Object.values(SEALING_PHASE_ENUM))})`,
)
@Check(
  DOCUMENT_SEALING_JOB_CONSTRAINTS.sealType,
  `"seal_type" IN (${sqlValues(Object.values(SEALING_TYPE_ENUM))})`,
)
export class DocumentSealingJobEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: DOCUMENT_SEALING_JOB_CONSTRAINTS.primaryKey,
  })
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  /**
   * `CASCADE` como el resto de las tablas hijas de `documents`: el trabajo no vive sin su documento.
   * `ManyToOne` y no `OneToOne`: este último crea su propia restricción única (`REL_…`) y
   * duplicaría `UQ_document_sealing_jobs_document_id` con otro nombre.
   */
  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'document_id',
    foreignKeyConstraintName:
      DOCUMENT_SEALING_JOB_CONSTRAINTS.documentForeignKey,
  })
  document: DocumentEntity;

  @Column({ name: 'seal_type', type: 'varchar', length: 32 })
  sealType: SEALING_TYPE_ENUM;

  @Column({
    type: 'varchar',
    length: 32,
    default: SEALING_JOB_STATUS_ENUM.PENDING,
  })
  status: SEALING_JOB_STATUS_ENUM;

  @Column({ type: 'varchar', length: 32 })
  phase: SEALING_PHASE_ENUM;

  /** Veces que un worker reclamó el trabajo. Registrarlo otra vez no lo reinicia. */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  /** Desde cuándo un worker puede reclamarlo; se pospone en cada reintento. */
  @Column({
    name: 'next_attempt_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  nextAttemptAt: Date;

  /** Identifica al worker que tiene reclamado el trabajo; `null` fuera de `PROCESSING`. */
  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken: string | null;

  /** Hasta cuándo vale el reclamo; pasado, otro worker puede recuperar el trabajo. */
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  /**
   * Llave, en el bucket privado `sealing-requests`, del payload congelado que se envía a Seal
   * Service. La firma simple lo congela al cerrar el documento; la avanzada, después de completar
   * su evidencia OCSP. `null` mientras no exista.
   */
  @Column({
    name: 'request_object_key',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  requestObjectKey: string | null;

  /** SHA-256 en hexadecimal de los bytes exactos del payload congelado; detecta si cambió. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64, nullable: true })
  requestHash: string | null;

  /** Código normalizado del último fallo, por ejemplo `SIMPLE_EVIDENCE_INCOMPLETE`. */
  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode: string | null;

  /** Diagnóstico sanitizado: sin datos personales, códigos de verificación ni respuestas crudas. */
  @Column({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage: string | null;

  /** Estado HTTP que devolvió el proveedor en el último fallo, si llegó a responder. */
  @Column({ name: 'last_upstream_status', type: 'int', nullable: true })
  lastUpstreamStatus: number | null;

  /** Cuándo llegó a `COMPLETED`. */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
