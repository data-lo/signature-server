import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeyService } from '../api-key.service';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyNotFoundException,
  ApiKeyOrganizationNotFoundException,
} from '../exceptions/api-key.exceptions';
import { OrganizationApiKeyData } from '../interfaces/response/organization-api-key-response';
import {
  OrganizationApiKeyActor,
  toOrganizationApiKeyData,
} from './organization-api-key.shared';

/**
 * `DELETE /api/v1/organizations/:organizationId/api-keys/:apiKeyId`: revocación lógica. La fila
 * se conserva como historial con `revokedAt` y `revokedByAccountId`.
 *
 * **Idempotente.** Revocar una llave ya revocada responde 200 con la llave tal como quedó, sin
 * tocar quién ni cuándo la revocó: el resultado que pidió el cliente ("esta llave no sirve") ya se
 * cumple, y un reintento por un timeout de red no debe convertirse en error. A diferencia del
 * directorio —donde archivar dos veces es 404—, aquí la llave revocada sigue visible en el
 * historial.
 */
@Injectable()
export class RevokeOrganizationApiKeyUseCase {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Revoca una llave de la organización.
   *
   * @param actor - Organización de la ruta y contexto autorizado.
   * @param apiKeyId - Llave a revocar.
   * @returns La llave revocada.
   *
   * @throws {ApiKeyOrganizationNotFoundException} (404) Si la organización no existe o está
   *   desactivada.
   * @throws {ApiKeyNotFoundException} (404) Si la llave no existe o es de otra organización.
   *
   * @example
   * ```ts
   * const { data } = await revokeOrganizationApiKey.execute(
   *   { organizationId: 'org-1', authorization },
   *   'key-1',
   * );
   * data.status; // 'REVOKED'
   * ```
   */
  async execute(
    { organizationId, authorization }: OrganizationApiKeyActor,
    apiKeyId: string,
  ): Promise<BaseResponse<OrganizationApiKeyData>> {
    const data = await this.apiKeyService.transaction(async (manager) => {
      const organization = await this.apiKeyService.lockActiveOrganization(
        manager,
        organizationId,
        'wait',
      );
      if (!organization) {
        throw new ApiKeyOrganizationNotFoundException();
      }

      const apiKey = await this.apiKeyService.lockApiKey(
        manager,
        organizationId,
        { id: apiKeyId },
      );
      if (!apiKey) {
        throw new ApiKeyNotFoundException();
      }

      if (apiKey.status === ApiKeyStatusEnum.ACTIVE) {
        await this.apiKeyService.markRevoked(
          manager,
          apiKey.id,
          authorization.accountId,
          new Date(),
        );
      }

      const revoked = await this.apiKeyService.findApiKey(
        organizationId,
        apiKeyId,
        manager,
      );

      return toOrganizationApiKeyData(revoked as NonNullable<typeof revoked>);
    });

    return { success: true, message: 'API key revocada correctamente', data };
  }
}
