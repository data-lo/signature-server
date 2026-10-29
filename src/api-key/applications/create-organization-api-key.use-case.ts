import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyService } from '../api-key.service';
import { CreateOrganizationApiKeyDto } from '../dto/create-organization-api-key.dto';
import {
  ApiKeyAlreadyActiveException,
  ApiKeyOrganizationNotFoundException,
  isOneActiveApiKeyViolation,
} from '../exceptions/api-key.exceptions';
import { IssuedOrganizationApiKeyData } from '../interfaces/response/organization-api-key-response';
import {
  issueApiKey,
  OrganizationApiKeyActor,
  parseExpiresAt,
  resolveAssignablePermissions,
} from './organization-api-key.shared';

/**
 * `POST /api/v1/organizations/:organizationId/api-keys`: emite la primera llave de la organización,
 * o una nueva después de revocar la anterior.
 *
 * La membresía activa y `API_KEY.MANAGE` los exige `PermissionsGuard`. Aquí se valida el resto y
 * se emite en una transacción con la fila de la organización bloqueada, para que dos altas
 * simultáneas no puedan ver las dos "no hay llave activa": la segunda espera, encuentra la de la
 * primera y responde 409. El índice único parcial sigue siendo la protección definitiva, y su
 * violación también sale como 409.
 */
@Injectable()
export class CreateOrganizationApiKeyUseCase {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeySecretService: ApiKeySecretService,
  ) {}

  /**
   * Emite una llave `ACTIVE` y devuelve su secreto, por única vez.
   *
   * @param actor - Organización de la ruta y cuenta que ejecuta la operación.
   * @param dto - Nombre, permisos y expiración opcional.
   * @returns La llave emitida, con `key` en claro.
   *
   * @throws {ApiKeyInvalidExpirationException} (422) Si `expiresAt` no es futura.
   * @throws {ApiKeyPermissionNotFoundException} (422) Si algún permiso no existe.
   * @throws {ApiKeyPermissionNotAllowedException} (422) Si algún permiso no es asignable.
   * @throws {ApiKeyOrganizationNotFoundException} (404) Si la organización no existe o está
   *   desactivada.
   * @throws {ApiKeyAlreadyActiveException} (409) Si ya tiene una llave activa.
   * @throws {ApiKeyNotConfiguredException} (500) Si falta `API_KEY_PEPPER`.
   *
   * @example
   * ```ts
   * const { data } = await createOrganizationApiKey.execute(
   *   { organizationId: 'org-1', accountId: 'acc-1' },
   *   { name: 'Integración ERP', permissionIds: ['perm-1'] },
   * );
   * data.key; // 'fma_live_…'
   * ```
   */
  async execute(
    { organizationId, accountId }: OrganizationApiKeyActor,
    dto: CreateOrganizationApiKeyDto,
  ): Promise<BaseResponse<IssuedOrganizationApiKeyData>> {
    const expiresAt = parseExpiresAt(dto.expiresAt, new Date());
    const permissions = await resolveAssignablePermissions(
      this.apiKeyService,
      dto.permissionIds,
    );

    try {
      const data = await this.apiKeyService.transaction(async (manager) => {
        const organization = await this.apiKeyService.lockActiveOrganization(
          manager,
          organizationId,
          'wait',
        );
        if (!organization) {
          throw new ApiKeyOrganizationNotFoundException();
        }

        if (
          await this.apiKeyService.findActiveApiKey(organizationId, manager)
        ) {
          throw new ApiKeyAlreadyActiveException();
        }

        return issueApiKey(
          manager,
          this.apiKeyService,
          this.apiKeySecretService,
          {
            organizationId,
            createdByAccountId: accountId,
            name: dto.name,
            permissions,
            expiresAt,
          },
        );
      });

      return { success: true, message: 'API key creada correctamente', data };
    } catch (error) {
      if (isOneActiveApiKeyViolation(error)) {
        throw new ApiKeyAlreadyActiveException();
      }
      throw error;
    }
  }
}
