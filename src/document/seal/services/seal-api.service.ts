import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { SealDocumentDto } from '../dto/seal-document.dto';
import {
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

/** Tiempo máximo de espera de Seal Service: emite dos sellos (TSA + NOM-151) contra un PSC externo. */
const SEAL_REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class SealApiService {
  private readonly logger = new Logger(SealApiService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Envía a Seal Service el arreglo de firmas del documento y devuelve su respuesta (hash
   * canónico + sello de tiempo + constancia NOM-151), que el caso de uso persiste.
   *
   * La autenticación es por API key en el header `x-api-key`, contra la variable `API_KEY` de
   * Seal Service. La clave sale de `SEAL_SERVICE_API_KEY` (ver `.env.example`) y nunca se registra
   * en los logs.
   *
   * Un 401 del proveedor (clave equivocada o ausente) se traduce a `SealProviderResponseException`
   * como cualquier otro error HTTP suyo: el sellado no ocurre, queda logueado, y la firma del
   * documento no se ve afectada (ver `DocumentService.sealAdvancedSignatures`).
   */
  async generateDocumentSeals(
    dto: SealDocumentDto,
  ): Promise<SealDocumentResponse> {
    const { serviceUrl, apiKey } = this.resolveConfiguration();
    this.logger.log(`Desde generateDocumentseal ocspEvidence firma 1 ${JSON.stringify(dto.signatures.at(0).ocspEvidence)}`)
    try {
      const httpResponse = await axios.post<SealDocumentResponse>(
        `${serviceUrl}/seal/signature`,
        dto,
        {
          headers: { 'x-api-key': apiKey },
          timeout: SEAL_REQUEST_TIMEOUT_MS,
        },
      );

      return this.assertUsableResponse(httpResponse.data, dto.documentId);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const upstreamStatus = error.response?.status;
        const upstreamData = error.response?.data;

        if (upstreamStatus) {
          this.logger.error(
            `El proveedor respondió HTTP ${upstreamStatus} 
             para el documento ${dto.documentId}, 
             error: ${JSON.stringify(upstreamData)}
             mensaje: ${error.response?.statusText}
             `,
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

  /**
   * La configuración se resuelve al invocar, NO en el constructor: este provider vive en un módulo
   * que carga la aplicación entera, así que lanzar desde el constructor impedía arrancar el
   * servidor completo (login, documentos, todo) por una integración que la mayoría de los
   * entornos de desarrollo no usa. Ahora la falta de configuración solo rompe el sellado, y con
   * un error explícito en vez de un 500 opaco.
   */
  private resolveConfiguration(): { serviceUrl: string; apiKey: string } {
    const serviceUrl = this.configService.get<string>('SEAL_SERVICE_URL');
    const apiKey = this.configService.get<string>('SEAL_SERVICE_API_KEY');

    if (!serviceUrl || !apiKey) {
      this.logger.error(
        'Falta la configuración del proveedor de sellado (SEAL_SERVICE_URL / SEAL_SERVICE_API_KEY).',
      );
      throw new SealProviderConfigurationException();
    }

    return { serviceUrl: serviceUrl.replace(/\/+$/, ''), apiKey };
  }

  /**
   * Todo lo que se valida acá termina en una columna NOT NULL de `document_seals`: sin esta
   * comprobación, una respuesta incompleta del proveedor no falla en la frontera HTTP sino más
   * tarde, como un error de constraint de Postgres que no dice nada del origen real.
   *
   * También es la red que atrapa un cambio de contrato del proveedor: si Seal Service renombrara
   * `hashHex` (la rama `staging` de ese repo, por ejemplo, lo llama `signHashHex`), acá se
   * convierte en un error explícito en vez de una fila con el hash vacío.
   */
  private assertUsableResponse(
    response: SealDocumentResponse | undefined,
    documentId: string,
  ): SealDocumentResponse {
    const isUsable =
      Boolean(response) &&
      Boolean(response.hashHex) &&
      Boolean(response.canonicalString) &&
      Boolean(response.timeStamp) &&
      Boolean(response.nom151);

    if (!isUsable) {
      this.logger.error(
        `El proveedor devolvió una respuesta incompleta para el documento ${documentId}.`,
      );
      throw new SealProviderResponseException();
    }

    return response;
  }
}
