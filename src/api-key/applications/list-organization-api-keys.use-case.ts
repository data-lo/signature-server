import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeyService } from '../api-key.service';
import { OrganizationApiKeyData } from '../interfaces/response/organization-api-key-response';
import {
  assertActiveOrganization,
  OrganizationApiKeyActor,
  toOrganizationApiKeyData,
} from './organization-api-key.shared';

/**
 * `GET /api/v1/organizations/:organizationId/api-keys`: historial de llaves de la organización,
 * vigente y revocadas, de la más nueva a la más vieja. Sin secreto ni hash.
 */
@Injectable()
export class ListOrganizationApiKeysUseCase {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Lista las llaves de la organización.
   *
   * @param actor - Organización de la ruta y contexto autorizado.
   * @returns Las llaves con sus metadatos y permisos; vacío si nunca emitió una.
   *
   * @throws {ApiKeyOrganizationNotFoundException} (404) Si la organización no existe o está
   *   desactivada.
   *
   * @example
   * ```ts
   * const { data } = await listOrganizationApiKeys.execute({ organizationId: 'org-1', authorization });
   * data.map((apiKey) => apiKey.status); // ['ACTIVE', 'REVOKED']
   * ```
   */
  async execute({
    organizationId,
  }: OrganizationApiKeyActor): Promise<BaseResponse<OrganizationApiKeyData[]>> {
    await assertActiveOrganization(this.apiKeyService, organizationId);

    const apiKeys = await this.apiKeyService.listApiKeys(organizationId);

    return {
      success: true,
      message: 'API keys obtenidas correctamente',
      data: apiKeys.map(toOrganizationApiKeyData),
    };
  }
}
