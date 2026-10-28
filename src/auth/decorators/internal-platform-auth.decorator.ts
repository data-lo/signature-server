import { applyDecorators, UseGuards } from '@nestjs/common';

import { InternalPlatformApiKeyGuard } from '../guards/internal-platform-api-key.guard';
import { SkipJwtAuth } from './skip-jwt-auth.decorator';

/**
 * Marca un controller (o un endpoint) como operación interna de plataforma: lo autentica
 * `INTERNAL_PLATFORM_API_KEY` en `x-api-key`, y nada más.
 *
 * - `@SkipJwtAuth()`: no hay usuario final ni sesión, así que `JwtAuthGuard` no aplica.
 * - **No es `@Public()`**: con `@Public()`, el `ApiKeyGuard` global compararía el header contra
 *   `API_KEY`, la llave compartida de los servicios. Sin él, ese guard deja pasar y el único que
 *   decide es `InternalPlatformApiKeyGuard`.
 * - Sin `@RequirePermission`, `PermissionsGuard` no interviene: no hay membresía que autorizar.
 *
 * Acompañarlo de `@ApiExcludeController()`: estas rutas no se publican en Swagger.
 *
 * @returns El decorador compuesto.
 *
 * @example
 * ```ts
 * @ApiExcludeController()
 * @InternalPlatformAuth()
 * @Controller('internal/organizations')
 * export class InternalOrganizationProvisioningController {}
 * ```
 */
export function InternalPlatformAuth(): ClassDecorator & MethodDecorator {
  return applyDecorators(SkipJwtAuth(), UseGuards(InternalPlatformApiKeyGuard));
}
