import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationInvitationEventsProducer } from './organization-invitation.producer';
import { KafkaProducerService } from './kafka-producer.service';
import { ORGANIZATION_INVITATION_KAFKA_TOPICS } from './organization-invitation.topics';

describe('OrganizationInvitationEventsProducer', () => {
  let producer: OrganizationInvitationEventsProducer;
  let kafkaProducer: { emit: jest.Mock };

  beforeEach(async () => {
    kafkaProducer = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationInvitationEventsProducer,
        { provide: KafkaProducerService, useValue: kafkaProducer },
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
});
