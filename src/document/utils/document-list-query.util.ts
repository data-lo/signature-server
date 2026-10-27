import { BadRequestException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';

import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DOCUMENT_SORT_FIELD_ENUM } from '../enum/document-sort-field.enum';

/**
 * Piezas de la consulta de listado de documentos que no dependen de QUIÉN pregunta: orden,
 * filtros por estatus y fechas, validación de rangos y paginación.
 *
 * Las comparten la bandeja de la plataforma (`GetDocumentsUseCase`, que además aplica visibilidad
 * por usuario, vistas y archivado) y la API de integración (`DocumentReadService`, que acota por
 * organización). La visibilidad NO vive aquí: cada llamador decide qué puede ver, y después usa
 * estas piezas para recortar dentro de eso.
 */

/**
 * De qué campo del enum sale cada columna del `ORDER BY`.
 *
 * El mapa es lo que convierte la lista cerrada del DTO en SQL. Es la única forma en que un valor
 * del cliente llega al ordenamiento, y llega como CLAVE de este objeto, nunca como texto: el
 * `ORDER BY` no admite parámetros preparados, así que lo que se interpola tiene que salir de acá.
 */
export const DOCUMENT_SORT_COLUMNS: Record<DOCUMENT_SORT_FIELD_ENUM, string> = {
  [DOCUMENT_SORT_FIELD_ENUM.CREATED_AT]: 'document.createdAt',
  [DOCUMENT_SORT_FIELD_ENUM.SIGNED_AT]: 'document.signedAt',
  [DOCUMENT_SORT_FIELD_ENUM.FILE_NAME]: 'document.fileName',
  [DOCUMENT_SORT_FIELD_ENUM.STATUS]: 'document.status',
};

/** Filtros por estatus y rangos de fecha (ISO 8601), todos opcionales. */
export interface DocumentStatusAndDateFilters {
  statuses?: DOCUMENT_STATUS_ENUM[];
  createdFrom?: string;
  createdTo?: string;
  signedFrom?: string;
  signedTo?: string;
}

export interface DocumentsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Rechaza un rango de fechas al revés.
 *
 * Un rango al revés (`desde` posterior a `hasta`) no devuelve nada, y en silencio: la lista sale
 * vacía y quien la mira no tiene cómo saber si es que no hay documentos o es que tecleó las fechas
 * cambiadas. Vale más un 400 que lo diga.
 *
 * @param from - Inicio del rango, o nada.
 * @param to - Fin del rango, o nada.
 * @param label - Qué fecha es ("creación", "firma"), para el mensaje.
 * @returns Nada.
 *
 * @throws {BadRequestException} (400) Si `from` es posterior a `to`.
 *
 * @example
 * ```ts
 * assertValidDocumentDateRange('2026-02-01', '2026-01-01', 'creación'); // lanza 400
 * ```
 */
export function assertValidDocumentDateRange(
  from: string | undefined,
  to: string | undefined,
  label: string,
): void {
  if (!from || !to) return;

  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new BadRequestException(
      `El rango de fechas de ${label} está invertido: la fecha inicial (${from}) es posterior a la final (${to})`,
    );
  }
}

/**
 * Valida los dos rangos de fecha de los filtros.
 *
 * @param filters - Filtros pedidos.
 * @returns Nada.
 *
 * @throws {BadRequestException} (400) Si algún rango está al revés.
 *
 * @example
 * ```ts
 * assertValidDocumentDateRanges({ createdFrom: '2026-01-01', createdTo: '2026-02-01' });
 * ```
 */
export function assertValidDocumentDateRanges(
  filters: DocumentStatusAndDateFilters,
): void {
  assertValidDocumentDateRange(
    filters.createdFrom,
    filters.createdTo,
    'creación',
  );
  assertValidDocumentDateRange(filters.signedFrom, filters.signedTo, 'firma');
}

/**
 * Agrega a la consulta los filtros por estatus y por fechas de creación y firma.
 *
 * @param qb - Consulta sobre `DocumentEntity` con alias `document`.
 * @param filters - Filtros pedidos; los ausentes no restringen.
 * @returns La misma consulta.
 *
 * @example
 * ```ts
 * applyDocumentStatusAndDateFilters(qb, { statuses: [DOCUMENT_STATUS_ENUM.SIGNED] });
 * ```
 */
export function applyDocumentStatusAndDateFilters(
  qb: SelectQueryBuilder<DocumentEntity>,
  filters: DocumentStatusAndDateFilters,
): SelectQueryBuilder<DocumentEntity> {
  const { statuses, createdFrom, createdTo, signedFrom, signedTo } = filters;

  if (statuses?.length) {
    qb.andWhere('document.status IN (:...statuses)', { statuses });
  }

  if (createdFrom) {
    qb.andWhere('document.createdAt >= :createdFrom', {
      createdFrom: new Date(createdFrom),
    });
  }

  if (createdTo) {
    qb.andWhere('document.createdAt <= :createdTo', {
      createdTo: new Date(createdTo),
    });
  }

  if (signedFrom) {
    qb.andWhere('document.signedAt >= :signedFrom', {
      signedFrom: new Date(signedFrom),
    });
  }

  if (signedTo) {
    qb.andWhere('document.signedAt <= :signedTo', {
      signedTo: new Date(signedTo),
    });
  }

  return qb;
}

/**
 * Metadatos de paginación de una página ya consultada.
 *
 * @param page - Página pedida (desde 1).
 * @param limit - Tamaño de página.
 * @param total - Total de documentos que cumplen los filtros.
 * @returns Página, tamaño, total y número de páginas.
 *
 * @example
 * ```ts
 * buildDocumentsPagination(1, 25, 42); // { page: 1, limit: 25, total: 42, totalPages: 2 }
 * ```
 */
export function buildDocumentsPagination(
  page: number,
  limit: number,
  total: number,
): DocumentsPagination {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
