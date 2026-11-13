import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { ApiKeyModule } from 'src/api-key/api-key.module';

import { GetIntegrationApiSettingsUseCase } from './applications/get-integration-api-settings.use-case';
import { GetIntegrationSettingsUseCase } from './applications/get-integration-settings.use-case';
import { UpdateIntegrationApiSettingsUseCase } from './applications/update-integration-api-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './applications/update-integration-settings.use-case';
import { IntegrationSettingsEntity } from './entities/integration-settings.entity';
import { IntegrationApiSettingsController } from './integration-api-settings.controller';
import { IntegrationSettingsController } from './integration-settings.controller';
import { IntegrationSettingsService } from './services/integration-settings.service';

/**
 * Configuración general de la API de integración por organización, con dos superficies sobre la
 * misma fila:
 * - `IntegrationSettingsController` (`/organizations/:organizationId/integration-settings`, JWT con
 *   `API_KEY.MANAGE`): el interruptor administrativo `ACTIVE`/`DISABLED` que
 *   `OrganizationApiKeyGuard` consulta en cada petición.
 * - `IntegrationApiSettingsController` (`/integration/settings`, API key con
 *   `INTEGRATION_SETTINGS.READ`/`UPDATE`): `webhooksEnabled`.
 *
 * Importa `ApiKeyModule` por `OrganizationApiKeyGuard` y `ApiKeyPermissionGuard`. La dependencia
 * es en un solo sentido: el guard y `issueApiKey` usan la entidad y
 * `ensureInitialIntegrationSettings` directamente, sin importar este módulo, así que no hay ciclo.
 * Exporta `IntegrationSettingsService` para que las tareas de webhooks consulten `webhooksEnabled`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationSettingsEntity, OrganizationEntity]),
    ApiKeyModule,
  ],
  controllers: [
    IntegrationSettingsController,
    IntegrationApiSettingsController,
  ],
  providers: [
    IntegrationSettingsService,
    GetIntegrationSettingsUseCase,
    UpdateIntegrationSettingsUseCase,
    GetIntegrationApiSettingsUseCase,
    UpdateIntegrationApiSettingsUseCase,
  ],
  exports: [IntegrationSettingsService],
})
export class IntegrationSettingsModule {}
