import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditQuery, AuditRecord, AuditService } from '../audit.service';
import {
  AuditRecordPage,
  buildCreatedAtFilter,
  resolvePagination,
} from './audit-listing';

/**
 * `GET /audit`: consulta general de registros de auditoría.
 *
 * Tiene dos modos, y los dos responden a la misma pregunta desde distinta distancia: con `id`
 * devuelve ese registro suelto (404 si no está), y sin `id` devuelve una página filtrable por
 * rango de fechas, de más reciente a más antiguo.
 */
@Injectable()
export class GetAuditRecordsUseCase {
  constructor(private readonly auditService: AuditService) {}

  async execute(
    query: AuditQuery,
  ): Promise<Record<string, any> | AuditRecordPage> {
    if (query.id) {
      return this.findById(query.id);
    }

    const { page, limit, skip } = resolvePagination(query);

    const [records, total] = await this.auditService.findPage(
      buildCreatedAtFilter(query),
      skip,
      limit,
    );

    const data = await Promise.all(
      records.map((record) => this.decryptWithTimestamp(record)),
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private async findById(id: string): Promise<Record<string, any>> {
    const record = await this.auditService.findById(id);

    if (!record) {
      throw new NotFoundException(`Registro de auditoría ${id} no encontrado`);
    }

    return this.decryptWithTimestamp(record);
  }

  /**
   * `createdAt` lo pone Mongo, no el contenido cifrado, así que hay que volver a pegarlo
   * después de descifrar: sin él la lista no se puede ordenar ni ubicar en el tiempo del lado
   * del cliente.
   */
  private async decryptWithTimestamp(
    record: AuditRecord,
  ): Promise<Record<string, any>> {
    return {
      ...(await this.auditService.decrypt(record)),
      createdAt: record.createdAt,
    };
  }
}
