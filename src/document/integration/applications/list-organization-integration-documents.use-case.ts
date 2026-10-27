import { Injectable } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DocumentReadService } from '../../services/document-read.service';
import { ListIntegrationDocumentsQueryDto } from '../dto/list-integration-documents-query.dto';
import { IntegrationDocumentsPage } from '../interfaces/integration-document-response';

/**
 * `GET /api/v1/integration/documents`: documentos de la organización de la API key.
 *
 * `DOCUMENT.READ + ORGANIZATION` lo exige `OrganizationApiKeyGuard`. La organización sale
 * exclusivamente de `apiClient.organizationId`; `DocumentReadService` la aplica siempre, así que
 * ningún filtro del cliente puede cruzar a otra.
 *
 * No reutiliza `GetDocumentsUseCase`: aquél parte de un usuario con JWT, su bandeja personal, su
 * archivado y `X-Account-Id`, nada de lo cual existe para una integración.
 */
@Injectable()
export class ListOrganizationIntegrationDocumentsUseCase {
  constructor(private readonly documentReadService: DocumentReadService) {}

  /**
   * Lista una página de documentos de la organización.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @param query - Paginación, orden y filtros por estatus y fechas.
   * @returns La página de resúmenes y su paginación.
   *
   * @throws {BadRequestException} (400) Si un rango de fechas está al revés.
   *
   * @example
   * ```ts
   * const { data } = await listOrganizationIntegrationDocuments.execute(apiClient, { page: 1, limit: 25 });
   * data.pagination.total; // 42
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    query: ListIntegrationDocumentsQueryDto,
  ): Promise<BaseResponse<IntegrationDocumentsPage>> {
    const data = await this.documentReadService.listOrganizationDocuments({
      organizationId: apiClient.organizationId,
      filters: query,
    });

    return {
      success: true,
      message: 'Documentos obtenidos correctamente',
      data,
    };
  }
}
