import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  initialPhase,
  RegisterDocumentSealingJobUseCase,
} from './register-document-sealing-job.use-case';

/**
 * Decisiones del registro. La unicidad y el rollback reales se prueban contra Postgres en
 * `test/document-sealing-concurrency.e2e-spec.ts`.
 */
describe('RegisterDocumentSealingJobUseCase', () => {
  let values: jest.Mock;
  let insertedRows: unknown[];
  let existing: Record<string, unknown>;
  let manager: { createQueryBuilder: jest.Mock; getRepository: jest.Mock };
  const useCase = new RegisterDocumentSealingJobUseCase();

  beforeEach(() => {
    insertedRows = [{ id: 'job-1' }];
    existing = { id: 'job-1', status: SEALING_JOB_STATUS_ENUM.PENDING };
    values = jest.fn();
    const builder = {
      insert: () => builder,
      into: () => builder,
      values: (row: unknown) => {
        values(row);
        return builder;
      },
      orIgnore: jest.fn(() => builder),
      returning: () => builder,
      execute: async () => ({ raw: insertedRows }),
    };
    manager = {
      createQueryBuilder: jest.fn(() => builder),
      getRepository: jest.fn(() => ({
        findOneByOrFail: jest.fn(async () => existing),
      })),
    };
  });

  it.each([
    [SEALING_TYPE_ENUM.ADVANCED, SEALING_PHASE_ENUM.VERIFYING_OCSP],
    [SEALING_TYPE_ENUM.SIMPLE, SEALING_PHASE_ENUM.GENERATING_SEAL],
  ])('el contrato %s empieza en %s', (sealType, phase) => {
    expect(initialPhase(sealType)).toBe(phase);
  });

  it('firma avanzada: PENDING, sin payload (se congela tras el OCSP)', async () => {
    await useCase.execute(
      { documentId: 'doc-1', sealType: SEALING_TYPE_ENUM.ADVANCED },
      manager as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        sealType: SEALING_TYPE_ENUM.ADVANCED,
        status: SEALING_JOB_STATUS_ENUM.PENDING,
        phase: SEALING_PHASE_ENUM.VERIFYING_OCSP,
        attemptCount: 0,
        requestObjectKey: null,
        requestHash: null,
      }),
    );
  });

  it('firma simple: guarda la referencia y el hash del payload congelado', async () => {
    await useCase.execute(
      {
        documentId: 'doc-1',
        sealType: SEALING_TYPE_ENUM.SIMPLE,
        request: { objectKey: 'doc-1/snap.json', hash: 'a'.repeat(64) },
      },
      manager as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
        requestObjectKey: 'doc-1/snap.json',
        requestHash: 'a'.repeat(64),
      }),
    );
  });

  it('con un bloqueo nace en RECONCILIATION_REQUIRED con su diagnóstico', async () => {
    await useCase.execute(
      {
        documentId: 'doc-1',
        sealType: SEALING_TYPE_ENUM.SIMPLE,
        blocker: {
          code: 'SIMPLE_EVIDENCE_INCOMPLETE',
          message: 'falta la INE',
        },
      },
      manager as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED,
        lastErrorCode: 'SIMPLE_EVIDENCE_INCOMPLETE',
        lastErrorMessage: 'falta la INE',
      }),
    );
  });

  it('si ya existía (ON CONFLICT DO NOTHING) devuelve el existente sin modificarlo', async () => {
    insertedRows = [];
    existing = {
      id: 'job-previo',
      status: SEALING_JOB_STATUS_ENUM.DEAD,
      attemptCount: 8,
    };

    const result = await useCase.execute(
      { documentId: 'doc-1', sealType: SEALING_TYPE_ENUM.ADVANCED },
      manager as never,
    );

    expect(result).toEqual({ job: existing, created: false });
  });

  it('usa el EntityManager de la transacción de cierre', async () => {
    const result = await useCase.execute(
      { documentId: 'doc-1', sealType: SEALING_TYPE_ENUM.ADVANCED },
      manager as never,
    );

    expect(manager.createQueryBuilder).toHaveBeenCalled();
    expect(result.created).toBe(true);
  });
});
