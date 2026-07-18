import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { INVITATION_STATUS_ENUM } from '../../enums/invitation-status.enum';

export class OrganizationInvitationPreviewData {
  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty({ example: 'Acme Corp S.A. de C.V.' })
  organizationName: string;

  @ApiProperty({ example: 'nuevo.miembro@empresa.com' })
  email: string;

  @ApiProperty({ enum: INVITATION_STATUS_ENUM })
  status: INVITATION_STATUS_ENUM;
}

export class OrganizationInvitationPreviewResponse extends BaseResponse<OrganizationInvitationPreviewData> {
  @ApiProperty({ type: OrganizationInvitationPreviewData })
  data: OrganizationInvitationPreviewData;
}
