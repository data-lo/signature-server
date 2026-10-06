import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

/**
 * Directorio de contactos por cuenta activa (personal u organización).
 *
 * Publica `GET/POST/PATCH/DELETE /directory/contacts`. La autorización la hace el
 * `PermissionsGuard` global (registrado por `AuthorizationModule`), así que este módulo no lo
 * importa. Exporta `TypeOrmModule` y `DirectoryService` para futuros consumidores (por ejemplo, el
 * selector de contactos al crear documentos).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DirectoryEntity, DirectoryContactEntity]),
  ],
  controllers: [DirectoryController],
  providers: [DirectoryService],
  exports: [TypeOrmModule, DirectoryService],
})
export class DirectoryModule {}
