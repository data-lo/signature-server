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
import { AuditChainModule } from 'src/audit-chain/audit-chain.module';

// Capacidades compartidas por los casos de uso de eventos
import { DocumentEventNotificationsService } from './document-event-notifications.service';
import { DocumentEventAuditService } from './document-event-audit.service';

import { ProcessDocumentCreatedEventUseCase } from './applications/process-document-created-event.use-case';
import { ProcessDocumentSentToSignEventUseCase } from './applications/process-document-sent-to-sign-event.use-case';
import { ProcessDocumentCollaboratorSignedEventUseCase } from './applications/process-document-collaborator-signed-event.use-case';
import { ProcessDocumentSignedEventUseCase } from './applications/process-document-signed-event.use-case';
import { ProcessDocumentRejectedEventUseCase } from './applications/process-document-rejected-event.use-case';
import { ProcessDocumentCancellationRequestedEventUseCase } from './applications/process-document-cancellation-requested-event.use-case';
import { ProcessDocumentCancelledEventUseCase } from './applications/process-document-cancelled-event.use-case';
import { SendPendingSignatureNotificationUseCase } from './applications/send-pending-signature-notification.use-case';
import { SendOrganizationInvitationEmailUseCase } from './applications/send-organization-invitation-email.use-case';

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
    AuditChainModule,
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
    DocumentEventNotificationsService,
    DocumentEventAuditService,
    ProcessDocumentCreatedEventUseCase,
    ProcessDocumentSentToSignEventUseCase,
    ProcessDocumentCollaboratorSignedEventUseCase,
    ProcessDocumentSignedEventUseCase,
    ProcessDocumentRejectedEventUseCase,
    ProcessDocumentCancellationRequestedEventUseCase,
    ProcessDocumentCancelledEventUseCase,
    SendPendingSignatureNotificationUseCase,
    SendOrganizationInvitationEmailUseCase,
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
