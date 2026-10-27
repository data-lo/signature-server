import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyEntity } from './entities/api-key.entity';

/**
 * API keys de organización: por ahora, sólo el modelo de persistencia.
 *
 * Registra `ApiKeyEntity` para que la conexión principal (`autoLoadEntities`) la conozca: sin un
 * `forFeature()` que la nombre, las relaciones `apiKeys` de `OrganizationEntity`,
 * `AccountEntity` y `PermissionEntity` no tendrían metadatos y la aplicación no arrancaría.
 * Exporta `TypeOrmModule` para que quien emita o valide llaves reciba el repositorio.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKeyEntity])],
  exports: [TypeOrmModule],
})
export class ApiKeyModule {}
