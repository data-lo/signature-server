import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

export class OrganizationPermissionData {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty({ example: 'Aprobar documentos' })
  name: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: '2023-10-25T10:00:00Z' })
  createdAt: Date;
}

export class OrganizationPermissionResponse extends BaseResponse<OrganizationPermissionData> {
  @ApiProperty({ type: OrganizationPermissionData })
  data: OrganizationPermissionData;
}

export class OrganizationPermissionListResponse extends BaseResponse<
  OrganizationPermissionData[]
> {
  @ApiProperty({ type: [OrganizationPermissionData] })
  data: OrganizationPermissionData[];
}

export class MemberPermissionsData {
  @ApiProperty({ format: 'uuid' })
  accountId: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  permissionIds: string[];
}

export class MemberPermissionsResponse extends BaseResponse<MemberPermissionsData> {
  @ApiProperty({ type: MemberPermissionsData })
  data: MemberPermissionsData;
}
