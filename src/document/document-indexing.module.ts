import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentIndexingJobEntity } from './entities/document-indexing-job.entity';
import { ProcessIndexerNotificationUseCase } from './applications/process-indexer-notification.use-case';

/**
 * Módulo independiente de `DocumentModule`: `WebhooksModule` sólo necesita actualizar el job, y
 * `DocumentModule` arrastraría Mongo, Kafka, MinIO y el sellado.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DocumentIndexingJobEntity])],
  providers: [ProcessIndexerNotificationUseCase],
  exports: [ProcessIndexerNotificationUseCase],
})
export class DocumentIndexingModule {}
