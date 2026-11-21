import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { CollaboratorEntity } from '../document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../document/enum/colaborator-type.enum';
import { SEALING_TYPE_ENUM } from '../document/seal/enums/sealing-type.enum';
import { IncompleteSimpleSignatureDataException } from '../document/seal/exceptions/seal.exceptions';
import { SealingRequestSnapshotReference } from '../document/seal/interfaces/sealing-request-snapshot.interface';
import { SealingRequestSnapshotService } from '../document/seal/services/sealing-request-snapshot.service';
import {
  RegisterDocumentSealingJobUseCase,
  SealingJobBlocker,
} from '../document/seal/use-cases/register-document-sealing-job.use-case';
import { resolveSealingType } from '../document/seal/utils/resolve-sealing-type.util';

/**
 * Registra el trabajo de sellado de los documentos firmados ANTES de `document_sealing_jobs` que
 * siguen esperando su constancia.
 *
 * **Candidatos, y sólo ellos:** documentos `SIGNED` con `sealing_pending_at`, sin trabajo y sin
 * constancia. Un documento histórico sin sello y SIN la marca no se toca: puede no ser elegible
 * (biométrico, o firmado antes de que existiera el sellado), y clasificarlo como pendiente sellaría
 * cosas que nadie pidió.
 *
 * Por cada candidato:
 * - Sin contrato de sellado (`resolveSealingType` → `null`, p. ej. biométrico) o sin `signed_hash`:
 *   se informa como no elegible y no se registra nada.
 * - Firma avanzada: trabajo en `VERIFYING_OCSP`; el worker completa el OCSP y congela el payload.
 * - Firma simple: se congela el payload, como al cerrar un documento. Si falta evidencia, el
 *   trabajo nace en `RECONCILIATION_REQUIRED` (`SIMPLE_EVIDENCE_INCOMPLETE`).
 *
 * Repetirlo es seguro: un documento con trabajo deja de ser candidato, y el registro hace
 * `ON CONFLICT DO NOTHING`. Con `--dry-run` sólo informa qué haría; no escribe en la base ni en
 * MinIO.
 *
 * Correrlo DESPUÉS de desplegar las migraciones y el contrato idempotente de Seal Service, y con el
 * worker listo para activarse: los trabajos registrados no avanzan mientras
 * `SEALING_WORKER_ENABLED=false`.
 *
 *   npm run sealing:backfill -- --dry-run
 *   npm run sealing:backfill -- --limit=200
 *   npm run sealing:backfill:prod -- --dry-run   # sobre dist/
 */

/** Cómo terminó cada candidato. */
export type BackfillOutcome =
  | 'WOULD_REGISTER'
  | 'REGISTERED'
  | 'REGISTERED_BLOCKED'
  | 'ALREADY_REGISTERED'
  | 'NOT_ELIGIBLE'
  | 'FAILED';

export interface BackfillDocumentResult {
  documentId: string;
  sealType: SEALING_TYPE_ENUM | null;
  outcome: BackfillOutcome;
  /** Motivo de un `NOT_ELIGIBLE`, `REGISTERED_BLOCKED` o `FAILED`; sin datos personales. */
  reason?: string;
}

export interface BackfillSummary {
  dryRun: boolean;
  candidates: number;
  counts: Record<BackfillOutcome, number>;
  documents: BackfillDocumentResult[];
}

export interface BackfillOptions {
  dryRun: boolean;
  /** Candidatos como máximo en esta corrida. */
  limit: number;
}

export interface BackfillDependencies {
  dataSource: DataSource;
  snapshots: Pick<
    SealingRequestSnapshotService,
    'freezeSimpleSignatureRequest' | 'discard'
  >;
  registerJob: Pick<RegisterDocumentSealingJobUseCase, 'execute'>;
  logger: Pick<Logger, 'log' | 'warn'>;
}

interface CandidateRow {
  id: string;
  original_hash: string | null;
  signed_hash: string | null;
}

/**
 * Busca los candidatos y registra su trabajo (o sólo informa, con `dryRun`).
 *
 * Un candidato que falla no detiene la corrida: se informa y se sigue.
 *
 * @param deps - Base, snapshots, registro de trabajos y logger.
 * @param options - `dryRun` y `limit`.
 * @returns El resumen por resultado y por documento.
 *
 * @example
 * ```ts
 * const summary = await backfillPendingSealingJobs(deps, { dryRun: true, limit: 500 });
 * summary.counts.WOULD_REGISTER; // 12
 * ```
 */
export async function backfillPendingSealingJobs(
  deps: BackfillDependencies,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const candidates = (await deps.dataSource.query(
    `SELECT d.id, d.original_hash, d.signed_hash
       FROM documents d
      WHERE d.status = 'SIGNED'
        AND d.sealing_pending_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM document_sealing_jobs j WHERE j.document_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM document_seals s WHERE s.document_id = d.id)
      ORDER BY d.sealing_pending_at, d.id
      LIMIT $1`,
    [options.limit],
  )) as CandidateRow[];

  const summary: BackfillSummary = {
    dryRun: options.dryRun,
    candidates: candidates.length,
    counts: {
      WOULD_REGISTER: 0,
      REGISTERED: 0,
      REGISTERED_BLOCKED: 0,
      ALREADY_REGISTERED: 0,
      NOT_ELIGIBLE: 0,
      FAILED: 0,
    },
    documents: [],
  };

  for (const candidate of candidates) {
    const result = await backfillOne(deps, candidate, options.dryRun);
    summary.counts[result.outcome] += 1;
    summary.documents.push(result);
    deps.logger.log(
      JSON.stringify({ event: 'sealing_backfill.document', ...result }),
    );
  }

  return summary;
}

/**
 * Procesa un candidato.
 *
 * @param deps - Dependencias.
 * @param candidate - Documento candidato.
 * @param dryRun - Si sólo se informa.
 * @returns Su resultado.
 *
 * @example
 * ```ts
 * const result = await backfillOne(deps, candidate, false);
 * ```
 */
async function backfillOne(
  deps: BackfillDependencies,
  candidate: CandidateRow,
  dryRun: boolean,
): Promise<BackfillDocumentResult> {
  const documentId = candidate.id;
  const signers = await deps.dataSource.getRepository(CollaboratorEntity).find({
    where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
    select: { id: true, colaboratorType: true, signatureType: true },
  });
  const sealType = resolveSealingType(signers);

  if (!sealType) {
    return {
      documentId,
      sealType,
      outcome: 'NOT_ELIGIBLE',
      reason: 'NO_SEALING_CONTRACT',
    };
  }
  if (!candidate.signed_hash || !candidate.original_hash) {
    return {
      documentId,
      sealType,
      outcome: 'NOT_ELIGIBLE',
      reason: 'MISSING_DOCUMENT_HASH',
    };
  }
  if (dryRun) {
    return { documentId, sealType, outcome: 'WOULD_REGISTER' };
  }

  let request: SealingRequestSnapshotReference | null = null;
  let blocker: SealingJobBlocker | null = null;
  try {
    if (sealType === SEALING_TYPE_ENUM.SIMPLE) {
      try {
        request = await deps.snapshots.freezeSimpleSignatureRequest({
          documentId,
          originalHash: candidate.original_hash,
          signedHash: candidate.signed_hash,
        });
      } catch (error) {
        if (!(error instanceof IncompleteSimpleSignatureDataException)) {
          throw error;
        }
        blocker = {
          code: 'SIMPLE_EVIDENCE_INCOMPLETE',
          message: error.message,
        };
      }
    }

    const { job, created } = await deps.dataSource.transaction((manager) =>
      deps.registerJob.execute(
        { documentId, sealType, request, blocker },
        manager,
      ),
    );

    if (!created) {
      if (request && job.requestObjectKey !== request.objectKey) {
        await deps.snapshots.discard(request.objectKey);
      }
      return { documentId, sealType, outcome: 'ALREADY_REGISTERED' };
    }
    return blocker
      ? {
          documentId,
          sealType,
          outcome: 'REGISTERED_BLOCKED',
          reason: blocker.code,
        }
      : { documentId, sealType, outcome: 'REGISTERED' };
  } catch (error) {
    if (request) {
      await deps.snapshots.discard(request.objectKey);
    }
    deps.logger.warn(
      `No se pudo registrar el trabajo del documento ${documentId}: ${
        error instanceof Error ? error.name : 'Error'
      }`,
    );
    return {
      documentId,
      sealType,
      outcome: 'FAILED',
      reason: error instanceof Error ? error.name : 'Error',
    };
  }
}

/**
 * Lee `--dry-run` y `--limit=N`.
 *
 * @param argv - Argumentos de la línea de comandos (sin `node` ni el script).
 * @returns Las opciones; `limit` por omisión 500.
 *
 * @throws {Error} Si `--limit` no es un entero positivo o hay un argumento desconocido.
 *
 * @example
 * ```ts
 * parseBackfillArgs(['--dry-run', '--limit=50']); // { dryRun: true, limit: 50 }
 * ```
 */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { dryRun: false, limit: 500 };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      const value = arg.slice('--limit='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error(
          `--limit debe ser un entero positivo (recibido "${value}").`,
        );
      }
      options.limit = Number(value);
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }
  return options;
}

/**
 * Punto de entrada: arma el contexto de Nest sin el worker y corre la recuperación.
 *
 * @returns Nada; el código de salida es 1 si algún documento falló.
 *
 * @example
 * ```ts
 * await main();
 * ```
 */
async function main(): Promise<void> {
  const logger = new Logger('BackfillPendingSealingJobs');
  const options = parseBackfillArgs(process.argv.slice(2));

  // El script no ejecuta trabajos: sólo los registra.
  process.env.SEALING_WORKER_ENABLED = 'false';

  const { AppModule } = await import('../app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const summary = await backfillPendingSealingJobs(
      {
        dataSource: app.get(DataSource),
        snapshots: app.get(SealingRequestSnapshotService),
        registerJob: app.get(RegisterDocumentSealingJobUseCase),
        logger,
      },
      options,
    );
    logger.log(
      JSON.stringify({
        event: 'sealing_backfill.summary',
        dryRun: summary.dryRun,
        candidates: summary.candidates,
        ...summary.counts,
      }),
    );
    if (summary.counts.FAILED > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

// `require.main` distingue ejecutar el script de importarlo desde una prueba.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
