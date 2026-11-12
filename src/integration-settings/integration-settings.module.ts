import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyModule } from 'src/api-key/api-key.module';

import { GetIntegrationSettingsUseCase } from './applications/get-integration-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './applications/update-integration-settings.use-case';
import { IntegrationSettingsEntity } from './entities/integration-settings.entity';
import { IntegrationSettingsController } from './integration-settings.controller';
import { IntegrationSettingsService } from './services/integration-settings.service';

/**
 * Configuración de la API de integración por organización (`GET`/`PATCH /integration/settings`).
 *
 * Importa `ApiKeyModule` por `OrganizationApiKeyGuard` y `ApiKeyPermissionGuard`. Exporta
 * `IntegrationSettingsService` para que las tareas de webhooks consulten `webhooksEnabled`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationSettingsEntity]),
    ApiKeyModule,
  ],
  controllers: [IntegrationSettingsController],
  providers: [
    IntegrationSettingsService,
    GetIntegrationSettingsUseCase,
    UpdateIntegrationSettingsUseCase,
  ],
  exports: [IntegrationSettingsService],
})
export class IntegrationSettingsModule {}
