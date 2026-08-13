import { BadGatewayException, HttpException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { HttpService } from '@nestjs/axios';
import { SealEntity } from '../entities/seal.entity';
import { Repository } from 'typeorm';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SealDocumentUseCase {

  constructor(
    readonly httpService: HttpService,
    readonly sealRepository: Repository<SealEntity>
  ) {

  }

  async create(sealDocumentDto: SealDocumentDto) {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<SealDocumentResponse>(
          `${process.env.SEAL_SERVICE_URL}/seal/signature`,
          sealDocumentDto,
          {
            headers: {
              'x-api-key': process.env.SEAL_SERVICE_API_KEY,
            },
            timeout: 15_000,
          },
        ),
      );

      if (!data) {

      }

      const newDocumentSeal = this.sealRepository.save(data)

      return 
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'No fue posible completar el sellado del documento.',
      );
    }

  }
}
