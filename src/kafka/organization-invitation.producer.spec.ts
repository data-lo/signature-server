import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationInvitationEventsProducer } from './organization-invitation.producer';
import { KafkaProducerService } from './kafka-producer.service';
import { ORGANIZATION_INVITATION_KAFKA_TOPICS } from './organization-invitation.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';

describe('OrganizationInvitationEventsProducer', () => {
  let producer: OrganizationInvitationEventsProducer;
  let kafkaProducer: { emit: jest.Mock };
  let eventService: { create: jest.Mock };

  beforeEach(async () => {
    kafkaProducer = { emit: jest.fn() };
    eventService = { create: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationInvitationEventsProducer,
        { provide: KafkaProducerService, useValue: kafkaProducer },
        { provide: EventService, useValue: eventService },
      ],
    }).compile();

    producer = module.get<OrganizationInvitationEventsProducer>(
      OrganizationInvitationEventsProducer,
    );
  });

  it('emitInvited publica en organization.member.invited con un eventId y timestamp generados', () => {
    producer.emitInvited({
      email: 'nuevo@empresa.com',
      organizationId: 'org-1',
      organizationName: 'Acme Corp',
      roleId: 'role-1',
      invitationToken: 'token-1',
      invitedBy: 'admin-1',
    });

    expect(kafkaProducer.emit).toHaveBeenCalledWith(
      ORGANIZATION_INVITATION_KAFKA_TOPICS.INVITED,
      expect.objectContaining({
        email: 'nuevo@empresa.com',
        organizationId: 'org-1',
        organizationName: 'Acme Corp',
        roleId: 'role-1',
        invitationToken: 'token-1',
        eventId: expect.any(String),
        timestamp: expect.any(String),
      }),
    );
  });

  it('emitInvited también persiste un Event de trazabilidad, sin el invitationToken en metadata', () => {
    producer.emitInvited({
      email: 'nuevo@empresa.com',
      organizationId: 'org-1',
      organizationName: 'Acme Corp',
      roleId: 'role-1',
      invitationToken: 'token-1',
      invitedBy: 'admin-1',
    });

    expect(eventService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: EVENT_TYPE_ENUM.ORGANIZATION_MEMBER_INVITED,
        from: 'admin-1',
        metadata: expect.objectContaining({
          email: 'nuevo@empresa.com',
          organizationId: 'org-1',
          organizationName: 'Acme Corp',
          roleId: 'role-1',
        }),
      }),
    );
    const metadataArg = eventService.create.mock.calls[0][0].metadata;
    expect(metadataArg.invitationToken).toBeUndefined();
  });
});
