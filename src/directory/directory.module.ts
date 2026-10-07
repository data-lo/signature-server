import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';

import { DirectoryCollaboratorsService } from './directory-collaborators.service';
import { DirectoryContactsController } from './directory-contacts.controller';
import { DirectoryContactsService } from './directory-contacts.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/**
 * Directorio de contactos por cuenta activa (personal u organización).
 *
 * Expone `/directory-contacts` (alta, edición, detalle y búsqueda por correo). `AccountEntity`
 * valida la cuenta activa y resuelve el vínculo con la cuenta personal de un usuario;
 * `UserEntity` encuentra a ese usuario por su correo. Exporta `TypeOrmModule` para que otros
 * consumidores reciban los repositorios del directorio, y `DirectoryCollaboratorsService` para que
 * la creación de documentos resuelva colaboradores del Directorio y registre los manuales.
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
  controllers: [DirectoryContactsController],
  providers: [DirectoryContactsService, DirectoryCollaboratorsService],
  exports: [TypeOrmModule, DirectoryCollaboratorsService],
})
export class DirectoryModule {}
