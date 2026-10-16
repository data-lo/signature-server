import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';

import { ArchiveDirectoryContactUseCase } from './applications/archive-directory-contact.use-case';
import { CreateDirectoryContactUseCase } from './applications/create-directory-contact.use-case';
import { ListDirectoryContactsUseCase } from './applications/list-directory-contacts.use-case';
import { UpdateDirectoryContactUseCase } from './applications/update-directory-contact.use-case';
import { DirectoryCollaboratorsService } from './directory-collaborators.service';
import { DirectoryContactsController } from './directory-contacts.controller';
import { DirectoryContactsService } from './directory-contacts.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

/**
 * Directorio de contactos por cuenta activa (personal u organización).
 *
 * Expone `/directory/contacts` (listado, alta, edición y archivado) y `/directory-contacts`
 * (alta, edición, detalle y búsqueda por correo). `DirectoryController` traduce cada petición a
 * la solicitud de su caso de uso (`applications/`), que aplica las reglas de negocio y usa
 * `DirectoryService` sólo para leer y escribir. `AccountEntity` valida la cuenta activa y
 * resuelve el vínculo con la cuenta personal de un usuario; `UserEntity` encuentra a ese
 * usuario por su correo. Exporta `TypeOrmModule` y `DirectoryService` para que otros
 * consumidores reciban los repositorios y el acceso a datos del directorio, y
 * `DirectoryCollaboratorsService` para que la creación de documentos resuelva colaboradores del
 * Directorio y registre los manuales.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DirectoryEntity,
      DirectoryContactEntity,
      AccountEntity,
      UserEntity,
    ]),
  ],
  controllers: [DirectoryController, DirectoryContactsController],
  providers: [
    DirectoryService,
    ListDirectoryContactsUseCase,
    CreateDirectoryContactUseCase,
    UpdateDirectoryContactUseCase,
    ArchiveDirectoryContactUseCase,
    DirectoryContactsService,
    DirectoryCollaboratorsService,
  ],
  exports: [TypeOrmModule, DirectoryService, DirectoryCollaboratorsService],
})
export class DirectoryModule {}
