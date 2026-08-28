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
   * Sello ya emitido para un documento, o `null` si no tiene.
   *
   * Lo usa el flujo de finalización cuando el sellado responde "ya sellado": pasa si un intento
   * anterior selló pero falló más adelante (al armar la hoja, por ejemplo) y la firma se reintentó.
   * Sin esto, el reintento perdería la constancia que sí existe y la hoja saldría sin ella.
   */
  async findByDocumentId(documentId: string): Promise<SealEntity | null> {
    return this.sealRepository.findOne({ where: { documentId } });
  }

  /**
   * Completa `integrityEvidence` con la serie y el `notBefore` del certificado TSA en una
   * evidencia que se creó antes de que existiera esta extracción (o cuya extracción falló al
   * sellar). La llama la vista pública cuando encuentra una evidencia sin estos campos y sí logra
   * extraerlos — así el reprocesamiento de ASN.1 no se repite en cada consulta.
   *
   * Recibe la evidencia completa (no solo el id) para reescribir el JSONB entero con los campos
   * que ya tenía más los dos nuevos: un `update` parcial de una columna `jsonb` reemplaza la
   * columna completa, no la mezcla.
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
        ...(certificateInfo.issuerCommonName && {
          certificateIssuerCommonName: certificateInfo.issuerCommonName,
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
