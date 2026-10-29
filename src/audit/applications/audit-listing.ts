import { AuditQuery } from '../audit.service';

/** Página de auditoría tal como la consumen `GET /audit` y `GET /audit/decrypted`. */
export interface AuditRecordPage {
  data: Record<string, any>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Paginación por defecto: primera página de 10 si el query no trae números utilizables. */
export function resolvePagination(query: AuditQuery): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Filtro de Mongo por rango de fechas. Cada extremo es opcional e independiente, y si no viene
 * ninguno el filtro queda vacío a propósito: "sin rango" significa todos los registros, no
 * ninguno.
 */
export function buildCreatedAtFilter(query: AuditQuery): Record<string, any> {
  const { dateFrom, dateTo } = query;

  if (!dateFrom && !dateTo) {
    return {};
  }

  const createdAt: Record<string, Date> = {};

  if (dateFrom) createdAt.$gte = new Date(dateFrom);
  if (dateTo) createdAt.$lte = new Date(dateTo);

  return { createdAt };
}
