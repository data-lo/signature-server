import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaTestController } from './kafka-test.controller';
import { DocumentEventsProducer } from './document-events.producer';
import { DocumentEventsConsumer } from './document-events.controller';
import { KAFKA_SERVICE } from './kafka.constants';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity,
      CollaboratorEntity,
      DocumentEntity,
    ]),
    ClientsModule.registerAsync([
      {
        name: KAFKA_SERVICE,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: config.get('KAFKA_CLIENT_ID'),
              brokers: [config.get('KAFKA_BROKER')],
            },
            consumer: {
              groupId: config.get('KAFKA_CONSUMER_GROUP_ID'),
            },
          },
        }),
      },
    ]),
  ],
  controllers: [KafkaTestController, DocumentEventsConsumer],
  providers: [KafkaProducerService, DocumentEventsProducer],
  exports: [ClientsModule, KafkaProducerService, DocumentEventsProducer],
})
export class KafkaModule {}
