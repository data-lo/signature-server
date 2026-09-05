import { Injectable, Logger } from '@nestjs/common';
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
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
}

/**
 * Forma con la que sale un registro de Mongo vía `.lean()`: el contenido del evento va cifrado
 * en `cipher` y los hashes viajan en claro para poder verificar la cadena sin descifrar nada.
 */
export interface AuditRecord {
  cipher: string;
  integrityHash: string;
  chainHash: string;
  chainIndex: number;
  createdAt?: Date;
  [key: string]: any;
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
      const integrityHash =
        await this.hashService.generateRegistryHash(recordData);

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
      this.logger.error(
        `[AuditService.create] Error registrando auditoría para documentId=${payload.documentId}: ${error}`,
      );
    }
  }

  /**
   * Devuelve los registros de un documento en orden de encadenamiento, crudos y cifrados: quién
   * puede leerlos y qué hacer si la lista está vacía lo decide el caso de uso.
   */
  async findByDocumentId(documentId: string): Promise<AuditRecord[]> {
    return this.auditModel
      .find({ documentId })
      .sort({ chainIndex: 1 })
      .lean() as unknown as Promise<AuditRecord[]>;
  }

  /** Un registro por su `_id` de Mongo, o `null` si no existe. */
  async findById(id: string): Promise<AuditRecord | null> {
    return this.auditModel
      .findById(id)
      .lean() as unknown as Promise<AuditRecord | null>;
  }

  /**
   * Devuelve una página de registros, del más reciente al más antiguo, junto con el total que
   * cumple el filtro. El filtro y el tamaño de página los arma quien llama.
   */
  async findPage(
    filter: Record<string, any>,
    skip: number,
    limit: number,
  ): Promise<[AuditRecord[], number]> {
    const [records, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.auditModel.countDocuments(filter),
    ]);

    return [records as unknown as AuditRecord[], total];
  }

  /**
   * Descifra el `cipher` de un registro y le vuelve a pegar los hashes de integridad, que son
   * justamente lo que permite verificar el contenido descifrado desde afuera.
   *
   * Si el descifrado falla se devuelve el registro tal cual está guardado, en vez de propagar
   * el error: un registro ilegible —clave rotada, dato corrupto— no debe hacer desaparecer de
   * la respuesta a los demás registros de la misma consulta, que sí son verificables.
   */
  async decrypt(record: AuditRecord): Promise<Record<string, any>> {
    try {
      const decryptedContent = await this.hashService.reverseCiperHash(
        record.cipher,
      );

      return {
        ...decryptedContent,
        integrityHash: record.integrityHash,
        chainHash: record.chainHash,
        chainIndex: record.chainIndex,
      };
    } catch {
      return record;
    }
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

      case AuditAction.DOCUMENT_CANCELLATION_REQUESTED:
      case AuditAction.DOCUMENT_CANCELLED:
      case AuditAction.DOCUMENT_REJECTED:
        break;
    }
  }
}
