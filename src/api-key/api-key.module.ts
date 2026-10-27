import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { PermissionEntity } from 'src/roles/entities/permission.entity';

import { ApiKeySecretService } from './api-key-secret.service';
import { ApiKeyService } from './api-key.service';
import { CreateOrganizationApiKeyUseCase } from './applications/create-organization-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './applications/get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './applications/list-organization-api-keys.use-case';
import { RevokeOrganizationApiKeyUseCase } from './applications/revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './applications/rotate-organization-api-key.use-case';
import { ApiKeyEntity } from './entities/api-key.entity';
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
 * permisos sin importar `AccountModule` ni `RolesModule`. Exporta `TypeOrmModule` y
 * `ApiKeySecretService` para quien valide llaves en el consumo externo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiKeyEntity,
      OrganizationEntity,
      PermissionEntity,
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
  ],
  exports: [TypeOrmModule, ApiKeySecretService],
})
export class ApiKeyModule {}
