import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentSealEntity } from './entities/document-seal.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { SealClientService } from './seal-client.service';

/**
 * Módulo independiente (mismo criterio que AuditChainModule/DocumentTransactionModule):
 * KafkaModule necesita SealClientService dentro de DocumentEventsConsumer, y este módulo no
 * depende de KafkaModule ni de DocumentModule — evita cualquier ciclo de imports entre ellos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DocumentSealEntity, CollaboratorEntity])],
  providers: [SealClientService],
  exports: [SealClientService],
})
export class SealModule {}
