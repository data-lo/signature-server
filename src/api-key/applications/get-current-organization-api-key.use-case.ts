import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeyService } from '../api-key.service';
import { ApiKeyNotFoundException } from '../exceptions/api-key.exceptions';
import { OrganizationApiKeyData } from '../interfaces/response/organization-api-key-response';
import {
  assertActiveOrganization,
  OrganizationApiKeyActor,
  toOrganizationApiKeyData,
} from './organization-api-key.shared';

/**
 * `GET /api/v1/organizations/:organizationId/api-keys/current`: la llave `ACTIVE` de la
 * organización, sin secreto.
 *
 * Una llave activa cuya `expiresAt` ya pasó se devuelve igual: vencer no cambia su estado, y es
 * el frontend quien la muestra como vencida comparando la fecha.
 */
@Injectable()
export class GetCurrentOrganizationApiKeyUseCase {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Devuelve la llave vigente.
   *
   * @param actor - Organización de la ruta y contexto autorizado.
   * @returns Prefijo, permisos, fechas de creación, último uso y expiración.
   *
   * @throws {ApiKeyOrganizationNotFoundException} (404) Si la organización no existe o está
   *   desactivada.
   * @throws {ApiKeyNotFoundException} (404) Si no tiene una llave activa.
   *
   * @example
   * ```ts
   * const { data } = await getCurrentOrganizationApiKey.execute({ organizationId: 'org-1', accountId: 'acc-1' });
   * data.prefix; // 'fma_live_3f9a0c1b2d4e5f60'
   * ```
   */
  async execute({
    organizationId,
  }: OrganizationApiKeyActor): Promise<BaseResponse<OrganizationApiKeyData>> {
    await assertActiveOrganization(this.apiKeyService, organizationId);

    const apiKey = await this.apiKeyService.findActiveApiKey(organizationId);
    if (!apiKey) {
      throw new ApiKeyNotFoundException(
        'La organización no tiene una API key activa',
      );
    }

    return {
      success: true,
      message: 'API key vigente obtenida correctamente',
      data: toOrganizationApiKeyData(apiKey),
    };
  }
}
