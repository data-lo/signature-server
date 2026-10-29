export enum ORGANIZATION_INVITATION_KAFKA_TOPICS {
  INVITED = 'organization.member.invited',
}

export interface OrganizationInvitationEventPayload {
  eventId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  roleId: string;
  invitationToken: string;
  timestamp: string;
}
