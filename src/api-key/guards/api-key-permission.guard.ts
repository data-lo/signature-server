import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { buildPermissionKey } from 'src/roles/permission-catalog.util';

import {
  REQUIRED_API_KEY_PERMISSION_METADATA,
  RequiredApiKeyPermission,
} from '../decorators/require-api-key-permission.decorator';
import {
  ApiKeyPermissionDeniedException,
  InvalidApiKeyException,
} from '../exceptions/api-key.exceptions';
import { IntegrationApiClient } from '../interfaces/integration-api-client.interface';
import { hasApiKeyPermission } from './organization-api-key.guard';

/**
 * Autorización de la API de integración: exige el permiso que el endpoint declaró con
 * `@RequireApiKeyPermission` sobre los permisos de la llave que resolvió
 * `OrganizationApiKeyGuard`. Va siempre después de él.
 *
 * Falla cerrado: una ruta sin permiso declarado se rechaza, para que olvidar el decorador no deje
 * un endpoint abierto a cualquier llave válida. Los permisos salen de la base, nunca del request.
 */
@Injectable()
export class ApiKeyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Comprueba el permiso del endpoint.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si la llave tiene el permiso con alguno de los alcances admitidos.
   *
   * @throws {InvalidApiKeyException} (401) Si no hay `request.apiClient` (falta
   *   `OrganizationApiKeyGuard` antes).
   * @throws {ApiKeyPermissionDeniedException} (403) Si la ruta no declara permiso o la llave no
   *   lo tiene.
   *
   * @example
   * ```ts
   * @UseGuards(OrganizationApiKeyGuard, ApiKeyPermissionGuard)
   * @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ, [PERMISSION_SCOPE_ENUM.ORGANIZATION])
   * ```
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ apiClient?: IntegrationApiClient }>();
    if (!request.apiClient) {
      throw new InvalidApiKeyException();
    }

    const required = this.reflector.getAllAndOverride<
      RequiredApiKeyPermission | undefined
    >(REQUIRED_API_KEY_PERMISSION_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      throw new ApiKeyPermissionDeniedException('un permiso declarado');
    }

    if (!hasApiKeyPermission(request.apiClient.permissions, required)) {
      throw new ApiKeyPermissionDeniedException(
        required.scopes
          .map((scope) =>
            buildPermissionKey(required.resource, required.action, scope),
          )
          .join(' o '),
      );
    }
    return true;
  }
}
