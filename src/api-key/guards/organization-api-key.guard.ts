import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { buildPermissionKey } from 'src/roles/permission-catalog.util';

import { ApiKeySecretService } from '../api-key-secret.service';
import {
  REQUIRED_API_KEY_PERMISSION_METADATA,
  RequiredApiKeyPermission,
} from '../decorators/require-api-key-permission.decorator';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyActorInactiveException,
  ApiKeyOrganizationInactiveException,
  ApiKeyPermissionDeniedException,
  ExpiredApiKeyException,
  InvalidApiKeyException,
} from '../exceptions/api-key.exceptions';
import {
  IntegrationApiClient,
  IntegrationApiClientPermission,
} from '../interfaces/integration-api-client.interface';

/** Header con el que el cliente externo presenta su llave. Express lo entrega en minúsculas. */
export const API_KEY_HEADER = 'x-api-key';

/**
 * Autenticación de la API de integración con la API key de una organización.
 *
 * Se declara por controller (`@UseGuards`), junto con `@SkipJwtAuth()`: estas rutas no llevan JWT,
 * y tampoco usan el `ApiKeyGuard` global, que compara `x-api-key` contra la llave interna de
 * `process.env.API_KEY` sólo en rutas `@Public()`.
 *
 * Valida, en este orden y sin atajos:
 * 1. formato de `X-API-Key` (`fma_live_<publicId>_<secret>`);
 * 2. que exista la llave de ese `publicId` y que el HMAC del secreto coincida (tiempo constante);
 * 3. estado `ACTIVE` y `expiresAt` futura;
 * 4. organización activa;
 * 5. que el actor —la membresía que emitió la llave— siga activo en ESA organización;
 * 6. el permiso que declaró el endpoint con `@RequireApiKeyPermission`.
 *
 * Deja el resultado en `request.apiClient` y marca `lastUsedAt`. **El valor de la llave no se
 * registra en ningún lado**: ni en logs, ni en excepciones, ni en `request.apiClient`.
 */
@Injectable()
export class OrganizationApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(OrganizationApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepository: Repository<ApiKeyEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    private readonly apiKeySecretService: ApiKeySecretService,
  ) {}

  /**
   * Autentica la llave de la petición y autoriza el permiso del endpoint.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si la llave es válida y tiene el permiso.
   *
   * @throws {InvalidApiKeyException} (401) Si la llave falta, no tiene formato, no existe, no
   *   coincide o está revocada.
   * @throws {ExpiredApiKeyException} (401) Si venció.
   * @throws {ApiKeyOrganizationInactiveException} (403) Si su organización está desactivada.
   * @throws {ApiKeyActorInactiveException} (403) Si su actor ya no es miembro activo.
   * @throws {ApiKeyPermissionDeniedException} (403) Si no tiene el permiso del endpoint.
   *
   * @example
   * ```ts
   * @SkipJwtAuth()
   * @UseGuards(OrganizationApiKeyGuard)
   * @Controller('integration')
   * export class IntegrationDocumentsController {}
   * ```
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = await this.authenticate(request.headers?.[API_KEY_HEADER]);

    if (!apiKey.organization?.isActive) {
      throw new ApiKeyOrganizationInactiveException();
    }

    const actor = await this.accountRepository.findOne({
      where: {
        id: apiKey.createdByAccountId,
        organizationId: apiKey.organizationId,
        isActive: true,
      },
      select: { id: true, userId: true },
    });
    if (!actor) {
      throw new ApiKeyActorInactiveException();
    }

    const permissions: IntegrationApiClientPermission[] =
      apiKey.permissions.map((permission) => ({
        resource: permission.resource.key as RESOURCE_KEY_ENUM,
        action: permission.action.key as ACTION_KEY_ENUM,
        scope: permission.scope as PERMISSION_SCOPE_ENUM,
      }));

    const required = this.reflector.getAllAndOverride<RequiredApiKeyPermission>(
      REQUIRED_API_KEY_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (required && !hasApiKeyPermission(permissions, required)) {
      throw new ApiKeyPermissionDeniedException(
        required.scopes
          .map((scope) =>
            buildPermissionKey(required.resource, required.action, scope),
          )
          .join(' o '),
      );
    }

    const apiClient: IntegrationApiClient = {
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      organizationId: apiKey.organizationId,
      actorAccountId: actor.id,
      actorUserId: actor.userId,
      permissions,
    };
    request.apiClient = apiClient;

    await this.touchLastUsedAt(apiKey.id);

    return true;
  }

  /**
   * Localiza la llave por su `publicId` y comprueba secreto, estado y vigencia.
   *
   * @param header - Valor crudo de `X-API-Key`.
   * @returns La llave con su organización y sus permisos.
   *
   * @throws {InvalidApiKeyException} (401) Si falta, no tiene formato, no existe, no coincide o
   *   está revocada.
   * @throws {ExpiredApiKeyException} (401) Si venció.
   *
   * @example
   * ```ts
   * const apiKey = await this.authenticate(request.headers['x-api-key']);
   * ```
   */
  private async authenticate(header: unknown): Promise<ApiKeyEntity> {
    const token =
      typeof header === 'string'
        ? this.apiKeySecretService.parseToken(header.trim())
        : null;
    if (!token) {
      throw new InvalidApiKeyException();
    }

    const apiKey = await this.apiKeyRepository.findOne({
      where: { publicId: token.publicId },
      relations: {
        organization: true,
        permissions: { resource: true, action: true },
      },
    });

    if (
      !apiKey ||
      !this.apiKeySecretService.matchesSecret(
        token.secret,
        apiKey.secretHash,
      ) ||
      apiKey.status !== ApiKeyStatusEnum.ACTIVE
    ) {
      throw new InvalidApiKeyException();
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      throw new ExpiredApiKeyException();
    }

    return apiKey;
  }

  /**
   * Registra el uso exitoso. Best-effort: un fallo al escribir la marca no debe rechazar una
   * petición ya autenticada.
   *
   * @param apiKeyId - Llave autenticada.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.touchLastUsedAt('key-1');
   * ```
   */
  private async touchLastUsedAt(apiKeyId: string): Promise<void> {
    try {
      await this.apiKeyRepository.update(apiKeyId, { lastUsedAt: new Date() });
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar el último uso de la API key ${apiKeyId}: ${error}`,
      );
    }
  }
}

/**
 * Indica si los permisos de una llave cubren lo que exige un endpoint.
 *
 * @param permissions - Permisos concedidos a la llave.
 * @param required - Recurso, acción y alcances aceptados por el endpoint.
 * @returns `true` si alguno coincide en recurso y acción y su alcance es `ANY` o uno de los
 *   aceptados.
 *
 * @example
 * ```ts
 * hasApiKeyPermission(
 *   [{ resource: 'DOCUMENT', action: 'READ', scope: 'OWN' }],
 *   { resource: 'DOCUMENT', action: 'READ', scopes: ['ORGANIZATION'] },
 * ); // false
 * ```
 */
export function hasApiKeyPermission(
  permissions: IntegrationApiClientPermission[],
  required: RequiredApiKeyPermission,
): boolean {
  return permissions.some(
    (permission) =>
      permission.resource === required.resource &&
      permission.action === required.action &&
      (permission.scope === PERMISSION_SCOPE_ENUM.ANY ||
        required.scopes.includes(permission.scope)),
  );
}

/**
 * Alcances que la llave tiene para un recurso y una acción.
 *
 * @param permissions - Permisos concedidos a la llave.
 * @param resource - Recurso.
 * @param action - Acción.
 * @returns Los alcances concedidos; vacío si no tiene el permiso.
 *
 * @example
 * ```ts
 * apiKeyScopes(apiClient.permissions, RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ); // ['OWN']
 * ```
 */
export function apiKeyScopes(
  permissions: IntegrationApiClientPermission[],
  resource: RESOURCE_KEY_ENUM,
  action: ACTION_KEY_ENUM,
): PERMISSION_SCOPE_ENUM[] {
  return permissions
    .filter(
      (permission) =>
        permission.resource === resource && permission.action === action,
    )
    .map((permission) => permission.scope);
}
