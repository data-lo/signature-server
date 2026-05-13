import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateAuditDto } from './dto/create-audit.dto';
import { FindAllAuditDto } from './dto/find-audit.dto';
import { AuditDocument, TypeOfOperation } from './schema/audit-document';
import { LogService } from 'src/log/log.service';
import { shortUuid } from 'src/common/utils/short-uuid.util';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditDocument.name)
    private readonly auditModel: Model<AuditDocument>,
    private readonly logService: LogService,
  ) {}

  /**
   * Crea un nuevo registro de auditoría asociado a un documento.
   *
   * Antes de persistir el registro:
   *  1. Valida que los campos obligatorios estén presentes según el tipo de operación.
   *  2. Calcula el chainIndex buscando el último registro del mismo documento
   *     y sumándole 1. Si no existe registro previo, el índice arranca en 1.
   *  3. Reserva los campos de hash (integrityHash, cipher, chainHash) para cuando
   *     las funciones de hashing estén disponibles.
   */
  async create(dto: CreateAuditDto) {
    const traceId = shortUuid();
    void this.logService.write(`[Audit] create - [${traceId}]`);

    this.validateOperationFields(dto, traceId);

    // Buscamos el registro más reciente del mismo documento para continuar la cadena.
    const previousRecord = await this.auditModel
      .findOne({ documentId: dto.documentId })
      .sort({ chainIndex: -1 });

    // chainIndex es un contador secuencial por documento que refleja cuántas veces
    // ha sido procesado; garantiza que los registros se puedan ordenar y verificar.
    const chainIndex = previousRecord ? previousRecord.chainIndex + 1 : 1;

    // TODO: integrar integrityHash — hash de la concatenación de todos los campos del documento
    // TODO: integrar cipher — hash encriptado de los campos del registro de audit
    // TODO: integrar chainHash — hash de la concatenación de todos los campos del registro de audit

    const result = await this.auditModel.create({
      ...dto,
      chainIndex,
      integrityHash: undefined,
      cipher: undefined,
      chainHash: undefined,
    });

    void this.logService.write(`[Audit] create - exito [${traceId}]`);
    return result;
  }

  /**
   * Retorna registros de auditoría con soporte de filtros y paginación.
   *
   * Comportamiento según los parámetros recibidos:
   *  - Si se proporciona `id`: retorna el registro exacto o lanza 404.
   *  - Si se proporcionan `dateFrom` / `dateTo`: filtra por rango en `createdAt`.
   *  - `page` y `limit` controlan la paginación (ambos con valor por defecto).
   *
   * La respuesta siempre incluye metadatos de paginación: total, página actual,
   * límite y totalPages para que el cliente pueda navegar el resultado.
   */
  async findAll(query: FindAllAuditDto) {
    const traceId = shortUuid();
    void this.logService.write(`[Audit] findAll - [${traceId}]`);

    const { id, dateFrom, dateTo, page = 1, limit = 10 } = query;

    // Atajo: si se pide un registro específico, lo resolvemos directamente.
    if (id) {
      const record = await this.auditModel.findById(id);
      if (!record) {
        void this.logService.write(`[Audit] findAll - error NotFoundException [${traceId}]`);
        throw new NotFoundException(`Registro de auditoría ${id} no encontrado`);
      }
      void this.logService.write(`[Audit] findAll - exito [${traceId}]`);
      return record;
    }

    const filter: Record<string, any> = {};

    // Construimos el filtro de rango de fechas solo con los extremos que lleguen.
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const skip = (page - 1) * limit;

    // Ejecutamos la consulta de datos y el conteo total en paralelo para reducir latencia.
    const [data, total] = await Promise.all([
      this.auditModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.auditModel.countDocuments(filter),
    ]);

    void this.logService.write(`[Audit] findAll - exito [${traceId}]`);
    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Valida que el DTO contenga los campos requeridos según el tipo de operación.
   *
   * Reglas:
   *  - SIGN: requiere `signedAt` (momento en que se firmó) y `verificationCodeId`.
   *  - APPROVE / REJECT: requieren `verificationCodeId` para trazabilidad del OTP usado.
   *  - CREATE: no requiere ninguno de los dos campos anteriores.
   */
  private validateOperationFields(dto: CreateAuditDto, traceId: string): void {
    if (dto.operation === TypeOfOperation.SIGN && !dto.signedAt) {
      void this.logService.write(`[Audit] create - error BadRequestException signedAt requerido [${traceId}]`);
      throw new BadRequestException('signedAt es requerido para la operación SIGN');
    }

    const requiresVerificationCode = [
      TypeOfOperation.SIGN,
      TypeOfOperation.APPROVE,
      TypeOfOperation.REJECT,
    ];

    if (requiresVerificationCode.includes(dto.operation) && !dto.verificationCodeId) {
      void this.logService.write(`[Audit] create - error BadRequestException verificationCodeId requerido [${traceId}]`);
      throw new BadRequestException(
        `verificationCodeId es requerido para la operación ${dto.operation}`,
      );
    }
  }
}
