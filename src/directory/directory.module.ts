import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/**
 * Directorio de contactos por cuenta activa (personal u organización).
 *
 * Por ahora sólo registra la persistencia; los casos de uso, los endpoints y el RBAC llegan en
 * tareas posteriores. Exporta `TypeOrmModule` para que esos consumidores reciban los repositorios.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DirectoryEntity, DirectoryContactEntity]),
  ],
  exports: [TypeOrmModule],
})
export class DirectoryModule {}
