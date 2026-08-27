import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AuditService } from '../audit.service';
import { GetAuditRecordsUseCase } from './get-audit-records.use-case';
import { AuditRecordPage } from './audit-listing';

describe('GetAuditRecordsUseCase', () => {
  let useCase: GetAuditRecordsUseCase;
  let auditService: {
    findById: jest.Mock;
    findPage: jest.Mock;
    decrypt: jest.Mock;
  };

  beforeEach(async () => {
    auditService = {
      findById: jest.fn(),
      findPage: jest.fn(),
      decrypt: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetAuditRecordsUseCase,
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    useCase = module.get(GetAuditRecordsUseCase);
  });

  describe('consulta por id', () => {
    it('devuelve el registro descifrado sin paginar', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      auditService.findById.mockResolvedValue({ cipher: 'c1', createdAt });
      auditService.decrypt.mockResolvedValue({ operation: 'DOCUMENT_CREATED' });

      const result = await useCase.execute({ id: 'audit-1' });

      expect(auditService.findById).toHaveBeenCalledWith('audit-1');
      expect(auditService.findPage).not.toHaveBeenCalled();
      expect(result).toEqual({ operation: 'DOCUMENT_CREATED', createdAt });
    });

    it('lanza NotFoundException si el id no existe', async () => {
      auditService.findById.mockResolvedValue(null);

      await expect(useCase.execute({ id: 'audit-x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listado paginado', () => {
    beforeEach(() => {
      auditService.findPage.mockResolvedValue([[], 0]);
    });

    it('usa pagina 1 y 10 por pagina cuando el query no trae paginacion', async () => {
      const result = (await useCase.execute({})) as AuditRecordPage;

      expect(auditService.findPage).toHaveBeenCalledWith({}, 0, 10);
      expect(result).toMatchObject({ page: 1, limit: 10, totalPages: 0 });
    });

    it('traduce page/limit a skip', async () => {
      await useCase.execute({ page: '3', limit: '25' });

      expect(auditService.findPage).toHaveBeenCalledWith({}, 50, 25);
    });

    it('arma el filtro por rango de fechas con los extremos recibidos', async () => {
      await useCase.execute({ dateFrom: '2026-01-01', dateTo: '2026-02-01' });

      expect(auditService.findPage).toHaveBeenCalledWith(
        {
          createdAt: {
            $gte: new Date('2026-01-01'),
            $lte: new Date('2026-02-01'),
          },
        },
        0,
        10,
      );
    });

    it('acepta un solo extremo del rango', async () => {
      await useCase.execute({ dateFrom: '2026-01-01' });

      expect(auditService.findPage).toHaveBeenCalledWith(
        { createdAt: { $gte: new Date('2026-01-01') } },
        0,
        10,
      );
    });

    it('descifra cada registro y le devuelve su createdAt', async () => {
      const createdAt = new Date('2026-03-01T10:00:00.000Z');
      auditService.findPage.mockResolvedValue([
        [{ cipher: 'c1', createdAt }],
        1,
      ]);
      auditService.decrypt.mockResolvedValue({ operation: 'DOCUMENT_SIGNED' });

      const result = (await useCase.execute({})) as AuditRecordPage;

      expect(result.data).toEqual([
        { operation: 'DOCUMENT_SIGNED', createdAt },
      ]);
    });

    it('calcula totalPages a partir del total y el tamano de pagina', async () => {
      auditService.findPage.mockResolvedValue([[], 21]);

      const result = (await useCase.execute({
        limit: '10',
      })) as AuditRecordPage;

      expect(result).toMatchObject({ total: 21, totalPages: 3 });
    });
  });
});
