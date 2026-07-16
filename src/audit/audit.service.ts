import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AuditDocument, AuditAction } from './schema/audit-document';
import { HashService } from '../shared/hash/hash.service';

export interface AuditQuery {
  id?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string | number;
  limit?: string | number;
}

export interface AuditPayload {
  documentId: string;
  operation: AuditAction;
  ipAddress: string;
  users?: { userId: string; action: AuditAction }[];
  verificationCodeId?: string;
  signedAt?: Date;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditDocument.name)
    private readonly auditModel: Model<AuditDocument>,
    private readonly hashService: HashService,
  ) {}

  /**
   * Crea un registro de auditoría con hashes de integridad y encadenamiento.
   * Captura y registra cualquier error sin propagarlo al flujo invocador.
   */
  async create(payload: AuditPayload): Promise<void> {
    try {
      this.validatePayload(payload);

      const previousRecord = await this.auditModel
        .findOne({ documentId: payload.documentId })
        .sort({ chainIndex: -1 })
        .lean();

      const chainIndex = previousRecord ? previousRecord.chainIndex + 1 : 1;

      const recordData = { ...payload, chainIndex };

      // Hash unidireccional del contenido del registro (integridad del propio registro)
      const integrityHash = await this.hashService.generateRegistryHash(recordData);

      // Contenido encadenado: incluye integrityHash y el chainHash previo para encadenamiento
      const chainContent = {
        ...recordData,
        integrityHash,
        previousChainHash: previousRecord?.chainHash ?? '0',
      };

      // chainHash: SHA-256 (unidireccional) | cipher: AES-256-GCM (bidireccional) — mismo contenido
      const [chainHash, cipher] = await Promise.all([
        this.hashService.generateRegistryHash(chainContent),
        this.hashService.generateCiperHash(chainContent),
      ]);

      await this.auditModel.create({
        ...recordData,
        integrityHash,
        chainHash,
        cipher,
      });
    } catch (error) {
      this.logger.error(`[AuditService.create] Error registrando auditoría para documentId=${payload.documentId}: ${error}`);
    }
  }

  /**
   * Retorna todos los registros de auditoría de un documento ordenados por chainIndex ASC.
   * Descifra el cipher de cada registro para exponer el contenido original verificable.
   */
  async findOne(documentId: string) {
    const records = await this.auditModel
      .find({ documentId })
      .sort({ chainIndex: 1 })
      .lean();

    if (!records.length) {
      throw new NotFoundException(`No se encontraron registros de auditoría para el documento ${documentId}`);
    }

    return Promise.all(
      records.map(async (record) => {
        try {
          const decryptedContent = await this.hashService.reverseCiperHash(record.cipher);
          return {
            ...decryptedContent,
            integrityHash: record.integrityHash,
            chainHash: record.chainHash,
            chainIndex: record.chainIndex,
          };
        } catch {
          return record;
        }
      }),
    );
  }

  /**
   * Igual que findAll pero descifra el cipher de cada registro antes de retornarlo.
   * Permite leer el contenido original de los registros de auditoría almacenados cifrados.
   */
  async findAllDecrypted(query: AuditQuery) {
    const { dateFrom, dateTo } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;

    const filter: Record<string, any> = {};

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      this.auditModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.auditModel.countDocuments(filter),
    ]);

    const data = await Promise.all(
      records.map(async (record) => {
        try {
          const decryptedContent = await this.hashService.reverseCiperHash(record.cipher);
          return {
            ...decryptedContent,
            integrityHash: record.integrityHash,
            chainHash: record.chainHash,
            chainIndex: record.chainIndex,
            createdAt: record['createdAt'],
          };
        } catch {
          return record;
        }
      }),
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retorna registros de auditoría descifrados con soporte de filtros y paginación.
   * Cada registro se descifra usando reverseCiperHash antes de ser retornado.
   */
  async findAll(query: AuditQuery) {
    const { id, dateFrom, dateTo } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;

    if (id) {
      const record = await this.auditModel.findById(id).lean();
      if (!record) throw new NotFoundException(`Registro de auditoría ${id} no encontrado`);
      try {
        const decryptedContent = await this.hashService.reverseCiperHash(record.cipher);
        return {
          ...decryptedContent,
          integrityHash: record.integrityHash,
          chainHash: record.chainHash,
          chainIndex: record.chainIndex,
          createdAt: record['createdAt'],
        };
      } catch {
        return record;
      }
    }

    const filter: Record<string, any> = {};

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      this.auditModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.auditModel.countDocuments(filter),
    ]);

    const data = await Promise.all(
      records.map(async (record) => {
        try {
          const decryptedContent = await this.hashService.reverseCiperHash(record.cipher);
          return {
            ...decryptedContent,
            integrityHash: record.integrityHash,
            chainHash: record.chainHash,
            chainIndex: record.chainIndex,
            createdAt: record['createdAt'],
          };
        } catch {
          return record;
        }
      }),
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Valida que el payload contenga los campos requeridos según el tipo de operación.
   * Usa switch para garantizar que solo se incluyan los campos aplicables a cada estado.
   */
  private validatePayload(payload: AuditPayload): void {
    switch (payload.operation) {
      case AuditAction.DOCUMENT_CREATED:
      case AuditAction.DOCUMENT_SENT_TO_SIGN:
        break;

      case AuditAction.DOCUMENT_SIGNED:
        if (!payload.signedAt) {
          throw new Error('signedAt es requerido para DOCUMENT_SIGNED');
        }
        break;

      case AuditAction.DOCUMENT_CANCELLED:
      case AuditAction.DOCUMENT_REJECTED:
        break;
    }
  }
}
