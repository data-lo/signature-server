import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './guards/api-key.guard';

/**
 * Módulo de autenticación.
 * Registra JwtAuthGuard como guard global: todos los endpoints requieren
 * autenticación Bearer por defecto, salvo los marcados con @Public().
 */
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AuthModule {}
