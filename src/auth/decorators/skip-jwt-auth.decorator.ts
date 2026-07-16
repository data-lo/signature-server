import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_JWT_KEY = 'skipJwtAuth';

/**
 * Usar SOLO en /auth/register y /auth/login: estas rutas no requieren
 * x-api-key (no son @Public()) ni un JWT (aún no existe sesión). Distinto
 * de @Public(), que sigue exigiendo x-api-key para las rutas existentes.
 */
export const SkipJwtAuth = () => SetMetadata(IS_SKIP_JWT_KEY, true);
