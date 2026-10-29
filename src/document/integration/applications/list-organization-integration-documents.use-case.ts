import { Injectable } from '@nestjs/common';

import { ApiKeyPermissionDeniedException } from 'src/api-key/exceptions/api-key.exceptions';
import { apiKeyScopes } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { buildPermissionKey } from 'src/roles/permission-catalog.util';

import { DocumentReadService } from '../../services/document-read.service';
import { ListIntegrationDocumentsQueryDto } from '../dto/list-integration-documents-query.dto';
import { IntegrationDocumentsPage } from '../interfaces/integration-document-response';

/**
 * `GET /api/v1/integration/documents`: documentos de la organización de la API key.
 *
 * `ApiKeyPermissionGuard` exige `DOCUMENT.READ` (la ruta también admite `OWN`, para el filtro por
 * creador) y este caso de uso exige además el alcance `ORGANIZATION`. La organización sale
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
   * @throws {ApiKeyPermissionDeniedException} (403) Si la llave sólo tiene `DOCUMENT.READ` con
   *   alcance `OWN`: la ruta admite `OWN` para el filtro por creador, pero el listado de toda la
   *   organización exige `ORGANIZATION`. Mismo error y código que daba el guard antes de admitir
   *   `OWN` en la ruta.
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
    const scopes = apiKeyScopes(
      apiClient.permissions,
      RESOURCE_KEY_ENUM.DOCUMENT,
      ACTION_KEY_ENUM.READ,
    );
    if (
      !scopes.includes(PERMISSION_SCOPE_ENUM.ORGANIZATION) &&
      !scopes.includes(PERMISSION_SCOPE_ENUM.ANY)
    ) {
      throw new ApiKeyPermissionDeniedException(
        buildPermissionKey(
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.READ,
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ),
      );
    }

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
