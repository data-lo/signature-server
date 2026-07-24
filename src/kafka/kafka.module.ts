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
import { NotificationEventsProducer } from './notification-events.producer';
import { NotificationEventsConsumer } from './notification-events.controller';
import { KAFKA_SERVICE } from './kafka.constants';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { SharedModule } from 'src/shared/shared.module';
import { EventModule } from 'src/event/event.module';
import { DocumentTransactionModule } from 'src/document/document-transaction.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity,
      CollaboratorEntity,
      DocumentEntity,
      UserEntity,
    ]),
    SharedModule,
    EventModule,
    DocumentTransactionModule,
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
    NotificationEventsConsumer,
  ],
  providers: [
    KafkaProducerService,
    DocumentEventsProducer,
    OrganizationInvitationEventsProducer,
    NotificationEventsProducer,
  ],
  exports: [
    ClientsModule,
    KafkaProducerService,
    DocumentEventsProducer,
    OrganizationInvitationEventsProducer,
    NotificationEventsProducer,
  ],
})
export class KafkaModule {}
