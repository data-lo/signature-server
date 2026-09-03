import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealEntity } from '../entities/seal.entity';
import { QueryFailedError, Repository } from 'typeorm';
import { SealApiService } from '../services/seal-api.service';
import { SealMapper } from '../mappers/seal.mapper';
import {
  DocumentAlreadySealedException,
  SealPersistenceException,
} from '../exceptions/seal.exceptions';
import { TsaCertificateInfo } from '../utils/tsa-certificate.util';

@Injectable()
export class SealDocumentUseCase {
  private readonly logger = new Logger(SealDocumentUseCase.name);

  constructor(
    private readonly sealApiService: SealApiService,
    @InjectRepository(SealEntity)
    private readonly sealRepository: Repository<SealEntity>,
  ) {}

  async create(sealDocumentDto: SealDocumentDto): Promise<SealEntity> {
    const response =
      await this.sealApiService.generateDocumentSeals(sealDocumentDto);

    const seal = this.sealRepository.create(
      SealMapper.toEntity(sealDocumentDto, response),
    );

    try {
      return await this.sealRepository.save(seal);
    } catch (error) {
      if (this.isDocumentAlreadySealedError(error)) {
        throw new DocumentAlreadySealedException();
      }

      this.logger.error(
        `No se pudo guardar la evidencia del documento ${sealDocumentDto.documentId}.`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new SealPersistenceException();
    }
  }

  /**
   * Devuelve el sello ya emitido para un documento, o `null` si no tiene.
   *
   * Lo usa el flujo de finalización cuando el sellado responde "ya sellado": pasa si un intento
   * anterior selló pero falló más adelante (al armar la hoja, por ejemplo) y la firma se reintentó.
   * Sin esto, el reintento perdería la constancia que sí existe y la hoja saldría sin ella.
   */
  async findByDocumentId(documentId: string): Promise<SealEntity | null> {
    return this.sealRepository.findOne({ where: { documentId } });
  }

  /**
   * Completa `integrityEvidence` con la serie y el `notBefore` del certificado TSA en una evidencia
   * anterior a que existiera esta extracción, o cuya extracción falló al sellar. La llama la vista
   * pública cuando encuentra una evidencia sin estos campos y sí logra extraerlos, para no
   * reprocesar el ASN.1 en cada consulta.
   *
   * Recibe la evidencia completa y no sólo el id porque un `update` parcial sobre una columna
   * `jsonb` reemplaza la columna entera en vez de mezclarla.
   */
  async persistIntegrityCertificateInfo(
    seal: SealEntity,
    certificateInfo: TsaCertificateInfo,
  ): Promise<void> {
    await this.sealRepository.update(seal.id, {
      integrityEvidence: {
        ...seal.integrityEvidence,
        certificateSerialNumber: certificateInfo.serialNumber,
        certificateIssuedAt: certificateInfo.issuedAt,
        // Condicional porque un DN puede no traer CN: sobrescribir con `undefined` borraría un
        // valor que un sellado posterior sí hubiera conseguido.
        ...(certificateInfo.subjectCommonName && {
          certificateSubjectCommonName: certificateInfo.subjectCommonName,
        }),
      },
    });
  }

  private isDocumentAlreadySealedError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === '23505';
  }
}
