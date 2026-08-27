import { Test, TestingModule } from '@nestjs/testing';

import { AuditService } from '../audit.service';
import { GetDecryptedAuditRecordsUseCase } from './get-decrypted-audit-records.use-case';

describe('GetDecryptedAuditRecordsUseCase', () => {
  let useCase: GetDecryptedAuditRecordsUseCase;
  let auditService: { findPage: jest.Mock; decrypt: jest.Mock };

  beforeEach(async () => {
    auditService = { findPage: jest.fn(), decrypt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetDecryptedAuditRecordsUseCase,
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    useCase = module.get(GetDecryptedAuditRecordsUseCase);
  });

  it('devuelve la pagina descifrada con sus metadatos de paginacion', async () => {
    const createdAt = new Date('2026-04-01T00:00:00.000Z');
    auditService.findPage.mockResolvedValue([[{ cipher: 'c1', createdAt }], 3]);
    auditService.decrypt.mockResolvedValue({ operation: 'DOCUMENT_CREATED' });

    const result = await useCase.execute({ page: '1', limit: '2' });

    expect(auditService.findPage).toHaveBeenCalledWith({}, 0, 2);
    expect(result).toEqual({
      data: [{ operation: 'DOCUMENT_CREATED', createdAt }],
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
    });
  });

  it('filtra por rango de fechas cuando el query lo trae', async () => {
    auditService.findPage.mockResolvedValue([[], 0]);

    await useCase.execute({ dateTo: '2026-05-01' });

    expect(auditService.findPage).toHaveBeenCalledWith(
      { createdAt: { $lte: new Date('2026-05-01') } },
      0,
      10,
    );
  });
});
