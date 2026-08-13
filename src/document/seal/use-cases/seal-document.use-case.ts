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

@Injectable()
export class SealDocumentUseCase {
  private readonly logger = new Logger(SealDocumentUseCase.name);

  constructor(
    private readonly sealApiService: SealApiService,
    @InjectRepository(SealEntity)
    private readonly sealRepository: Repository<SealEntity>,
  ) { }

  async create(sealDocumentDto: SealDocumentDto): Promise<SealEntity> {
    const response = await this.sealApiService.generateDocumentSeals(sealDocumentDto);

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

  private isDocumentAlreadySealedError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === '23505';
  }
}
