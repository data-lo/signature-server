import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArchiveDirectoryContactUseCase } from './applications/archive-directory-contact.use-case';
import { CreateDirectoryContactUseCase } from './applications/create-directory-contact.use-case';
import { ListDirectoryContactsUseCase } from './applications/list-directory-contacts.use-case';
import { UpdateDirectoryContactUseCase } from './applications/update-directory-contact.use-case';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

/**
 * Directorio de contactos por cuenta activa (personal u organización).
 *
 * `DirectoryController` traduce cada petición a la solicitud de su caso de uso (`applications/`),
 * que aplica las reglas de negocio y usa `DirectoryService` sólo para leer y escribir.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DirectoryEntity, DirectoryContactEntity]),
  ],
  controllers: [DirectoryController],
  providers: [
    DirectoryService,
    ListDirectoryContactsUseCase,
    CreateDirectoryContactUseCase,
    UpdateDirectoryContactUseCase,
    ArchiveDirectoryContactUseCase,
  ],
  exports: [TypeOrmModule, DirectoryService],
})
export class DirectoryModule {}
