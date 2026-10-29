import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionEntity } from 'src/roles/entities/permission.entity';
import {
  buildPermissionKey,
  comparePermissionKeys,
} from 'src/roles/permission-catalog.util';

import { isApiKeyAssignablePermission } from '../api-key-permission-policy';
import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyService } from '../api-key.service';
import {
  ApiKeyPermissionNotAllowedException,
  ApiKeyPermissionNotFoundException,
} from '../exceptions/api-key.exceptions';
import { IssuedOrganizationApiKeyData } from '../interfaces/response/organization-api-key-response';
import { issueApiKey } from './organization-api-key.shared';

/** Lo que decide quien emite una llave de plataforma. */
export interface IssuePlatformApiKeyParams {
  /** Organización dueña de la llave; puede haberse creado en la misma transacción. */
  organizationId: string;
  /** Nombre administrativo de la llave. */
  name: string;
  /** Perfil de permisos ya resuelto con `resolvePermissionProfile`. */
  permissions: PermissionEntity[];
}

/**
 * Emite API keys en nombre de la PLATAFORMA, no de una membresía: `createdByAccountId = null`.
 *
 * Es la emisión que usa el aprovisionamiento interno (`PlatformProvisioningModule`), que crea la
 * organización y su llave en una sola transacción y todavía no tiene —ni debe tener— un
 * administrador que la firme. Las reglas que no dependen del emisor se mantienen: los permisos
 * pasan por la misma lista blanca (`api-key-permission-policy.ts`), el secreto sólo se guarda como
 * HMAC y la llave completa se devuelve una única vez. No hay endpoint público que llegue aquí.
 */
@Injectable()
export class IssuePlatformApiKeyUseCase {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeySecretService: ApiKeySecretService,
  ) {}

  /**
   * Carga del catálogo un perfil de permisos por sus claves y exige que todos existan y sean
   * asignables a una API key.
   *
   * Se llama ANTES de abrir la transacción del llamador: un catálogo sin sembrar o un perfil con un
   * permiso administrativo se descubren sin haber escrito nada.
   *
   * @param permissionKeys - Claves `RECURSO.ACCION[_ALCANCE]` del perfil.
   * @returns Los permisos, con recurso y acción cargados, en el orden del catálogo.
   *
   * @throws {ApiKeyPermissionNotFoundException} (422) Si alguna clave no está en el catálogo.
   * @throws {ApiKeyPermissionNotAllowedException} (422) Si alguna no se puede conceder a una llave.
   *
   * @example
   * ```ts
   * const permissions = await issuePlatformApiKey.resolvePermissionProfile(['DOCUMENT.CREATE']);
   * ```
   */
  async resolvePermissionProfile(
    permissionKeys: readonly string[],
  ): Promise<PermissionEntity[]> {
    const forbiddenKeys = permissionKeys.filter(
      (key) => !isApiKeyAssignablePermission(key),
    );
    if (forbiddenKeys.length > 0) {
      throw new ApiKeyPermissionNotAllowedException(forbiddenKeys);
    }

    const permissions =
      await this.apiKeyService.findPermissionsByKeys(permissionKeys);
    const foundKeys = new Set(permissions.map(toPermissionKey));
    const missingKeys = permissionKeys.filter((key) => !foundKeys.has(key));
    if (missingKeys.length > 0) {
      throw new ApiKeyPermissionNotFoundException(missingKeys);
    }

    return permissions.sort((first, second) =>
      comparePermissionKeys(toPermissionKey(first), toPermissionKey(second)),
    );
  }

  /**
   * Emite una llave `ACTIVE`, sin vencimiento y sin emisor, dentro de la transacción del llamador.
   *
   * No bloquea la organización ni comprueba que no tenga ya una llave activa: el llamador la acaba
   * de crear en la misma transacción. El índice único parcial
   * `uq_api_keys_one_active_per_organization` sigue siendo la protección final.
   *
   * @param manager - Transacción en curso.
   * @param params - Organización, nombre y permisos.
   * @returns Los metadatos de la llave más `key`, la llave completa en claro, que no se vuelve a
   *   poder obtener.
   *
   * @throws {ApiKeyNotConfiguredException} (500) Si falta `INTEGRATION_API_KEY_HMAC_SECRET`.
   * @throws {QueryFailedError} Si la base rechaza la fila (p. ej. una segunda llave activa).
   *
   * @example
   * ```ts
   * const issued = await issuePlatformApiKey.issueWithin(manager, {
   *   organizationId: 'org-1', name: 'Integración Enterprise Acme', permissions,
   * });
   * issued.key; // 'fma_live_…'
   * ```
   */
  issueWithin(
    manager: EntityManager,
    params: IssuePlatformApiKeyParams,
  ): Promise<IssuedOrganizationApiKeyData> {
    return issueApiKey(manager, this.apiKeyService, this.apiKeySecretService, {
      organizationId: params.organizationId,
      createdByAccountId: null,
      name: params.name,
      permissions: params.permissions,
      expiresAt: null,
    });
  }
}

function toPermissionKey(permission: PermissionEntity): string {
  return buildPermissionKey(
    permission.resource.key,
    permission.action.key,
    permission.scope,
  );
}
