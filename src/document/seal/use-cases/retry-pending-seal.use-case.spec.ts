import { DocumentEntity } from '../../entities/document.entity';
import { RetryPendingSealUseCase } from './retry-pending-seal.use-case';

describe('RetryPendingSealUseCase', () => {
  const pendingDocument = (
    overrides: Partial<DocumentEntity> = {},
  ): DocumentEntity =>
    ({
      id: 'doc-1',
      sealingPendingAt: new Date('2026-11-19T18:00:00.000Z'),
      ...overrides,
    }) as unknown as DocumentEntity;

  let collaboratorRepository: { find: jest.Mock; update: jest.Mock };
  let documentRepository: { update: jest.Mock };
  let sealingJobRepository: { existsBy: jest.Mock };
  let useCase: RetryPendingSealUseCase;

  beforeEach(() => {
    collaboratorRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };
    documentRepository = { update: jest.fn() };
    sealingJobRepository = { existsBy: jest.fn().mockResolvedValue(false) };
    useCase = new RetryPendingSealUseCase(
      documentRepository as never,
      collaboratorRepository as never,
      sealingJobRepository as never,
      {} as never,
      {} as never,
    );
  });

  /**
   * Un documento con trabajo de sellado lo sella el worker. Si la vista pública también lo
   * reintentara, sellaría en paralelo y, en firma simple, borraría la marca sin sellar.
   */
  it('no toca un documento que tiene trabajo de sellado', async () => {
    sealingJobRepository.existsBy.mockResolvedValue(true);

    await expect(useCase.execute(pendingDocument())).resolves.toBe(false);
    expect(sealingJobRepository.existsBy).toHaveBeenCalledWith({
      documentId: 'doc-1',
    });
    expect(collaboratorRepository.find).not.toHaveBeenCalled();
    expect(documentRepository.update).not.toHaveBeenCalled();
  });

  it('sigue atendiendo a los documentos firmados antes de existir los trabajos', async () => {
    await expect(useCase.execute(pendingDocument())).resolves.toBe(true);
    // Sin firmantes FIEL a los que les falte OCSP, la marca obsoleta se limpia.
    expect(documentRepository.update).toHaveBeenCalledWith('doc-1', {
      sealingPendingAt: null,
    });
  });

  it('sin marca de pendiente no consulta nada', async () => {
    await expect(
      useCase.execute(pendingDocument({ sealingPendingAt: null })),
    ).resolves.toBe(false);
    expect(sealingJobRepository.existsBy).not.toHaveBeenCalled();
  });
});
