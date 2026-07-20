import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaTestController } from './kafka-test.controller';
import { DocumentEventsProducer } from './document-events.producer';
import { DocumentEventsConsumer } from './document-events.controller';
import { OrganizationInvitationEventsProducer } from './organization-invitation.producer';
import { OrganizationInvitationEventsConsumer } from './organization-invitation-events.controller';
import { KAFKA_SERVICE } from './kafka.constants';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { SharedModule } from 'src/shared/shared.module';
import { EventModule } from 'src/event/event.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity,
      CollaboratorEntity,
      DocumentEntity,
    ]),
    SharedModule,
    EventModule,
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
  controllers: [
    KafkaTestController,
    DocumentEventsConsumer,
    OrganizationInvitationEventsConsumer,
  ],
  providers: [
    KafkaProducerService,
    DocumentEventsProducer,
    OrganizationInvitationEventsProducer,
  ],
  exports: [
    ClientsModule,
    KafkaProducerService,
    DocumentEventsProducer,
    OrganizationInvitationEventsProducer,
  ],
})
export class KafkaModule {}
