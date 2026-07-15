import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como público: el guard global omite la validación de autenticación.
 * Usar en rutas que no requieren token (health checks, docs, flujos OTP, etc.).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Usar en un endpoint puntual de un controller marcado @Public() a nivel de
 * clase (ej. AccountController) para exigirle JWT en vez de x-api-key.
 * getAllAndOverride() prioriza el metadato del handler sobre el de la clase,
 * así que este `false` gana sobre el `true` de la clase.
 */
export const RequireAuth = () => SetMetadata(IS_PUBLIC_KEY, false);
