import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { PermissionEntity } from 'src/roles/entities/permission.entity';

import { ApiKeySecretService } from './api-key-secret.service';
import { ApiKeyService } from './api-key.service';
import { CreateOrganizationApiKeyUseCase } from './applications/create-organization-api-key.use-case';
import { IssuePlatformApiKeyUseCase } from './applications/issue-platform-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './applications/get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './applications/list-organization-api-keys.use-case';
import { RevokeOrganizationApiKeyUseCase } from './applications/revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './applications/rotate-organization-api-key.use-case';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ApiKeyPermissionGuard } from './guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from './guards/organization-api-key.guard';
import { OrganizationApiKeysController } from './organization-api-keys.controller';

/**
 * API keys de organización: el modelo y su administración interna
 * (`/organizations/:organizationId/api-keys`).
 *
 * `OrganizationApiKeysController` traduce cada petición a su caso de uso (`applications/`), que
 * aplica las reglas y usa `ApiKeyService` sólo para leer y escribir; `ApiKeySecretService` genera
 * el secreto y su HMAC. La autorización (`API_KEY.MANAGE`) la hace el `PermissionsGuard` global de
 * `AuthorizationModule`, así que este módulo no lo importa.
 *
 * Registra `ApiKeyEntity` para que la conexión principal (`autoLoadEntities`) la conozca: sin un
 * `forFeature()` que la nombre, las relaciones `apiKeys` de `OrganizationEntity`,
 * `AccountEntity` y `PermissionEntity` no tendrían metadatos y la aplicación no arrancaría.
 * `OrganizationEntity` y `PermissionEntity` se registran para validar la organización y los
 * permisos sin importar `AccountModule` ni `RolesModule`; `AccountEntity`, para que
 * `OrganizationApiKeyGuard` compruebe que el actor de la llave sigue activo. Exporta el guard (y lo
 * que necesita para inyectarse) a los módulos que expongan la API de integración, y
 * `IssuePlatformApiKeyUseCase` al aprovisionamiento interno, que emite llaves sin membresía.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiKeyEntity,
      OrganizationEntity,
      PermissionEntity,
      AccountEntity,
    ]),
  ],
  controllers: [OrganizationApiKeysController],
  providers: [
    ApiKeyService,
    ApiKeySecretService,
    CreateOrganizationApiKeyUseCase,
    ListOrganizationApiKeysUseCase,
    GetCurrentOrganizationApiKeyUseCase,
    RotateOrganizationApiKeyUseCase,
    RevokeOrganizationApiKeyUseCase,
    IssuePlatformApiKeyUseCase,
    OrganizationApiKeyGuard,
    ApiKeyPermissionGuard,
  ],
  exports: [
    TypeOrmModule,
    ApiKeySecretService,
    IssuePlatformApiKeyUseCase,
    OrganizationApiKeyGuard,
    ApiKeyPermissionGuard,
  ],
})
export class ApiKeyModule {}
