import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AuditService } from '../audit.service';
import { GetDocumentAuditTrailUseCase } from './get-document-audit-trail.use-case';

describe('GetDocumentAuditTrailUseCase', () => {
  let useCase: GetDocumentAuditTrailUseCase;
  let auditService: { findByDocumentId: jest.Mock; decrypt: jest.Mock };

  beforeEach(async () => {
    auditService = { findByDocumentId: jest.fn(), decrypt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetDocumentAuditTrailUseCase,
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    useCase = module.get(GetDocumentAuditTrailUseCase);
  });

  it('descifra cada registro del documento conservando el orden de la cadena', async () => {
    auditService.findByDocumentId.mockResolvedValue([
      { chainIndex: 1, cipher: 'c1' },
      { chainIndex: 2, cipher: 'c2' },
    ]);
    auditService.decrypt.mockImplementation((record) =>
      Promise.resolve({ operation: `op-${record.chainIndex}` }),
    );

    const result = await useCase.execute('doc-1');

    expect(auditService.findByDocumentId).toHaveBeenCalledWith('doc-1');
    expect(result).toEqual([{ operation: 'op-1' }, { operation: 'op-2' }]);
  });

  /**
   * Sin registros no hay traza que auditar: devolver una lista vacía haría pasar por
   * "documento sin eventos" lo que en realidad es "no existe esa traza".
   */
  it('lanza NotFoundException si el documento no tiene registros', async () => {
    auditService.findByDocumentId.mockResolvedValue([]);

    await expect(useCase.execute('doc-inexistente')).rejects.toThrow(
      NotFoundException,
    );
    expect(auditService.decrypt).not.toHaveBeenCalled();
  });
});
