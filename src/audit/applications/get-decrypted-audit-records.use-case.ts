import { Injectable } from '@nestjs/common';

import { AuditQuery, AuditRecord, AuditService } from '../audit.service';
import {
  AuditRecordPage,
  buildCreatedAtFilter,
  resolvePagination,
} from './audit-listing';

/**
 * `GET /audit/decrypted`: página de registros de auditoría con el contenido descifrado.
 *
 * A diferencia de `GET /audit`, no acepta `id`: es siempre un listado. Se mantiene como
 * endpoint aparte porque el frontend de auditoría ya apunta ahí y cambiar la ruta está fuera
 * del alcance de esta refactorización.
 */
@Injectable()
export class GetDecryptedAuditRecordsUseCase {
  constructor(private readonly auditService: AuditService) {}

  async execute(query: AuditQuery): Promise<AuditRecordPage> {
    const { page, limit, skip } = resolvePagination(query);

    const [records, total] = await this.auditService.findPage(
      buildCreatedAtFilter(query),
      skip,
      limit,
    );

    const data = await Promise.all(
      records.map(async (record: AuditRecord) => ({
        ...(await this.auditService.decrypt(record)),
        createdAt: record.createdAt,
      })),
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
