import { APP_GUARD } from '@nestjs/core';

import { AuthorizationModule } from './authorization.module';
import { PermissionsGuard } from './guards/permissions.guard';
import { AuthorizationService } from './services/authorization.service';

/**
 * Prueba de CABLEADO, no de comportamiento: lo que hace `PermissionsGuard` con un permiso ya lo
 * cubre `permissions.guard.spec.ts`.
 *
 * Existe porque este es el cableado que faltaba y nadie lo notaba. `@RequirePermission` sólo
 * escribe metadata; si nadie registra el guard que la lee, los endpoints anotados se quedan sin
 * autorización y responden 200 — una regresión que ninguna prueba unitaria ve, porque cada pieza
 * por separado sigue estando bien.
 */
describe('AuthorizationModule', () => {
  /** Los providers declarados en el decorador `@Module`. */
  const providers: unknown[] =
    Reflect.getMetadata('providers', AuthorizationModule) ?? [];

  it('registra PermissionsGuard como guard global', () => {
    expect(providers).toContainEqual({
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    });
  });

  /**
   * El guard inyecta `AuthorizationService`, así que tiene que estar declarado en ESTE módulo:
   * los `APP_GUARD` se instancian en el contexto del módulo donde se registran.
   */
  it('declara el AuthorizationService del que depende el guard', () => {
    expect(providers).toContain(AuthorizationService);
  });
});
