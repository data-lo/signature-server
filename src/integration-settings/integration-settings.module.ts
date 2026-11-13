import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';

import { GetIntegrationSettingsUseCase } from './applications/get-integration-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './applications/update-integration-settings.use-case';
import { IntegrationSettingsEntity } from './entities/integration-settings.entity';
import { IntegrationSettingsController } from './integration-settings.controller';
import { IntegrationSettingsService } from './services/integration-settings.service';

/**
 * Configuración general de la API de integración por organización: un interruptor administrativo
 * `ACTIVE`/`DISABLED` que `OrganizationApiKeyGuard` consulta en cada petición.
 *
 * El guard y `issueApiKey` (módulo `ApiKeyModule`) usan la entidad y
 * `ensureInitialIntegrationSettings` directamente, sin importar este módulo: lo único que necesitan
 * es la tabla, y así no se crea una dependencia circular entre módulos.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationSettingsEntity, OrganizationEntity]),
  ],
  controllers: [IntegrationSettingsController],
  providers: [
    IntegrationSettingsService,
    GetIntegrationSettingsUseCase,
    UpdateIntegrationSettingsUseCase,
  ],
})
export class IntegrationSettingsModule {}
