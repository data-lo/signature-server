import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyService } from '../api-key.service';
import { RotateOrganizationApiKeyDto } from '../dto/rotate-organization-api-key.dto';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyNotFoundException,
  ApiKeyOrganizationNotFoundException,
  ApiKeyRotationConflictException,
  isLockNotAvailableError,
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
 * `POST /api/v1/organizations/:organizationId/api-keys/rotate`: revoca la llave vigente y emite
 * otra en la misma transacción. La anterior se conserva como `REVOKED`.
 *
 * Lo omitido en el body se hereda de la llave vigente —nombre y permisos, que se vuelven a validar
 * contra la política—, salvo `expiresAt`: una fecha de vencimiento es de una llave concreta, y
 * heredarla podría emitir una llave ya vencida.
 *
 * **Concurrencia.** La fila de la organización se bloquea con `NOWAIT`: si otra rotación (o un
 * alta) de la misma organización está en curso, ésta responde 409 en el acto en vez de esperar y
 * rotar a su vez la llave que la otra acaba de emitir, lo que invalidaría un secreto que el otro
 * cliente todavía no terminó de recibir.
 */
@Injectable()
export class RotateOrganizationApiKeyUseCase {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeySecretService: ApiKeySecretService,
  ) {}

  /**
   * Rota la llave vigente y devuelve el secreto de la nueva, por única vez.
   *
   * @param actor - Organización de la ruta y contexto autorizado.
   * @param dto - Nombre, permisos y expiración de la llave nueva; todo opcional.
   * @returns La llave nueva, con `key` en claro.
   *
   * @throws {ApiKeyInvalidExpirationException} (422) Si `expiresAt` no es futura.
   * @throws {ApiKeyPermissionNotFoundException} (422) Si algún permiso no existe.
   * @throws {ApiKeyPermissionNotAllowedException} (422) Si algún permiso —pedido o heredado— no es
   *   asignable.
   * @throws {ApiKeyOrganizationNotFoundException} (404) Si la organización no existe o está
   *   desactivada.
   * @throws {ApiKeyNotFoundException} (404) Si no tiene una llave activa que rotar.
   * @throws {ApiKeyRotationConflictException} (409) Si otra operación de la misma organización
   *   está en curso.
   * @throws {ApiKeyNotConfiguredException} (500) Si falta `API_KEY_PEPPER`.
   *
   * @example
   * ```ts
   * const { data } = await rotateOrganizationApiKey.execute(
   *   { organizationId: 'org-1', authorization },
   *   { name: 'Integración ERP - llave 2027' },
   * );
   * data.key; // 'fma_live_…'
   * ```
   */
  async execute(
    { organizationId, authorization }: OrganizationApiKeyActor,
    dto: RotateOrganizationApiKeyDto = {},
  ): Promise<BaseResponse<IssuedOrganizationApiKeyData>> {
    const now = new Date();
    const expiresAt = parseExpiresAt(dto.expiresAt, now);
    const requestedPermissions = dto.permissionIds
      ? await resolveAssignablePermissions(
          this.apiKeyService,
          dto.permissionIds,
        )
      : null;

    try {
      const data = await this.apiKeyService.transaction(async (manager) => {
        const organization = await this.apiKeyService.lockActiveOrganization(
          manager,
          organizationId,
          'nowait',
        );
        if (!organization) {
          throw new ApiKeyOrganizationNotFoundException();
        }

        const locked = await this.apiKeyService.lockApiKey(
          manager,
          organizationId,
          { status: ApiKeyStatusEnum.ACTIVE },
        );
        const current =
          locked &&
          (await this.apiKeyService.findApiKey(
            organizationId,
            locked.id,
            manager,
          ));
        if (!current) {
          throw new ApiKeyNotFoundException(
            'La organización no tiene una API key activa que rotar',
          );
        }

        const permissions =
          requestedPermissions ??
          (await resolveAssignablePermissions(
            this.apiKeyService,
            current.permissions.map((permission) => permission.id),
          ));

        await this.apiKeyService.markRevoked(
          manager,
          current.id,
          authorization.accountId,
          now,
        );

        return issueApiKey(
          manager,
          this.apiKeyService,
          this.apiKeySecretService,
          {
            organizationId,
            createdByAccountId: authorization.accountId,
            name: dto.name ?? current.name,
            permissions,
            expiresAt,
          },
        );
      });

      return { success: true, message: 'API key rotada correctamente', data };
    } catch (error) {
      if (isLockNotAvailableError(error) || isOneActiveApiKeyViolation(error)) {
        throw new ApiKeyRotationConflictException();
      }
      throw error;
    }
  }
}
