import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como público: el guard global omite la validación de autenticación.
 * Usar en rutas que no requieren token (health checks, docs, flujos OTP, etc.).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
