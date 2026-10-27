import { BadRequestException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';

import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import {
  applyDocumentStatusAndDateFilters,
  assertValidDocumentDateRange,
  assertValidDocumentDateRanges,
  buildDocumentsPagination,
} from './document-list-query.util';

/**
 * Regresión del refactor de `GetDocumentsUseCase`: estas piezas salieron de ahí sin cambiar su
 * SQL, y ahora también las usa la API de integración (`DocumentReadService`).
 */
describe('document-list-query.util', () => {
  function queryBuilder() {
    const qb = { andWhere: jest.fn() };
    qb.andWhere.mockReturnValue(qb);
    return qb as unknown as SelectQueryBuilder<DocumentEntity> & {
      andWhere: jest.Mock;
    };
  }

  it('sin filtros no restringe nada', () => {
    const qb = queryBuilder();

    applyDocumentStatusAndDateFilters(qb, {});

    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('aplica estatus y las cuatro fechas con las mismas condiciones de la bandeja', () => {
    const qb = queryBuilder();

    applyDocumentStatusAndDateFilters(qb, {
      statuses: [DOCUMENT_STATUS_ENUM.SIGNED],
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      signedFrom: '2026-01-10T00:00:00.000Z',
      signedTo: '2026-01-20T00:00:00.000Z',
    });

    expect(qb.andWhere.mock.calls).toEqual([
      ['document.status IN (:...statuses)', { statuses: ['SIGNED'] }],
      [
        'document.createdAt >= :createdFrom',
        { createdFrom: new Date('2026-01-01T00:00:00.000Z') },
      ],
      [
        'document.createdAt <= :createdTo',
        { createdTo: new Date('2026-02-01T00:00:00.000Z') },
      ],
      [
        'document.signedAt >= :signedFrom',
        { signedFrom: new Date('2026-01-10T00:00:00.000Z') },
      ],
      [
        'document.signedAt <= :signedTo',
        { signedTo: new Date('2026-01-20T00:00:00.000Z') },
      ],
    ]);
  });

  it('un arreglo de estatus vacío no restringe', () => {
    const qb = queryBuilder();

    applyDocumentStatusAndDateFilters(qb, { statuses: [] });

    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('rechaza un rango al revés con el mismo mensaje de antes', () => {
    expect(() =>
      assertValidDocumentDateRange('2026-02-01', '2026-01-01', 'creación'),
    ).toThrow(
      new BadRequestException(
        'El rango de fechas de creación está invertido: la fecha inicial (2026-02-01) es posterior a la final (2026-01-01)',
      ),
    );
  });

  it('valida los dos rangos y acepta los abiertos', () => {
    expect(() =>
      assertValidDocumentDateRanges({ createdFrom: '2026-01-01' }),
    ).not.toThrow();
    expect(() =>
      assertValidDocumentDateRanges({
        signedFrom: '2026-03-01',
        signedTo: '2026-01-01',
      }),
    ).toThrow(/firma/);
  });

  it('calcula la paginación', () => {
    expect(buildDocumentsPagination(2, 25, 51)).toEqual({
      page: 2,
      limit: 25,
      total: 51,
      totalPages: 3,
    });
    expect(buildDocumentsPagination(1, 25, 0).totalPages).toBe(0);
  });
});
