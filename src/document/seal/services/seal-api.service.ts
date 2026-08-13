import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import { SealDocumentDto } from '../dto/seal-document.dto';
import {
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

@Injectable()
export class SealApiService {
  private readonly logger = new Logger(SealApiService.name);
  private readonly serviceUrl: string;
  private readonly apiKey: string;

  constructor(private readonly httpService: HttpService) {
    const serviceUrl = process.env.SEAL_SERVICE_URL;
    const apiKey = process.env.SEAL_SERVICE_API_KEY;

    if (!serviceUrl || !apiKey) {
      this.logger.error('Falta la configuración del proveedor de sellado.');
      throw new SealProviderConfigurationException();
    }

    this.serviceUrl = serviceUrl;
    this.apiKey = apiKey;
  }

  async generateDocumentSeals(
    dto: SealDocumentDto,
  ): Promise<SealDocumentResponse> {
    try {
      const httpResponse = await firstValueFrom(
        this.httpService.post<SealDocumentResponse>(
          `${this.serviceUrl}/seal/signature`,
          dto,
          {
            headers: {
              'x-api-key': this.apiKey,
            },
            timeout: 15_000,
          },
        ),
      );

      const response = httpResponse.data;

      if (!response) {
        this.logger.error(
          `El proveedor no devolvió datos para el documento ${dto.documentId}.`,
        );
        throw new SealProviderResponseException();
      }

      return response;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const upstreamStatus = error.response?.status;

        if (upstreamStatus) {
          this.logger.error(
            `El proveedor respondió HTTP ${upstreamStatus} para el documento ${dto.documentId}.`,
          );
          throw new SealProviderResponseException();
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          this.logger.error(
            `Timeout al generar sellos para el documento ${dto.documentId}.`,
          );
          throw new SealProviderTimeoutException();
        }

        this.logger.error(
          `No se pudo conectar con el proveedor de sellado para el documento ${dto.documentId} (code=${error.code ?? 'unknown'}).`,
        );
        throw new SealProviderUnavailableException();
      }

      throw error;
    }
  }
}
