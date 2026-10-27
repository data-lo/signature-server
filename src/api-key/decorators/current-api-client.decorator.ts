import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { IntegrationApiClient } from '../interfaces/integration-api-client.interface';

/**
 * Entrega al controller el `request.apiClient` que dejó `OrganizationApiKeyGuard`.
 *
 * Sólo tiene valor en endpoints protegidos por ese guard; fuera de ellos devuelve `undefined`, y
 * usarlo ahí es un error de programación, igual que `@CurrentAuthorization()` sin
 * `@RequirePermission`.
 *
 * @returns El cliente autenticado de la petición en curso.
 *
 * @example
 * ```ts
 * list(@CurrentApiClient() apiClient: IntegrationApiClient) {}
 * ```
 */
export const CurrentApiClient = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): IntegrationApiClient =>
    ctx.switchToHttp().getRequest().apiClient,
);
