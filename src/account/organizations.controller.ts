// NestJS core
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Use cases
import { CreateOrganizationUseCase } from './applications/create-organization.use-case';
import { InviteOrganizationMemberUseCase } from './applications/invite-organization-member.use-case';
import { GetOrganizationMemberListUseCase } from './applications/get-organization-member-list.use-case';
import { UpdateAccountMemberUseCase } from './applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './applications/revoke-account-access.use-case';
import { GetMemberPermissionsUseCase } from 'src/organization-permissions/applications/get-member-permissions.use-case';
import { AssignMemberPermissionsUseCase } from 'src/organization-permissions/applications/assign-member-permissions.use-case';

// DTOs
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { AssignMemberPermissionsDto } from 'src/organization-permissions/dto/assign-member-permissions.dto';

// Docs
import { ApiCreateOrganization } from './docs/api-create-organization.docs';
import { ApiInviteOrganizationMember } from './docs/api-invite-organization-member.docs';
import { ApiGetOrganizationMemberList } from './docs/api-get-organization-member-list.docs';
import { ApiUpdateOrganizationMemberRole } from './docs/api-update-organization-member-role.docs';
import { ApiRemoveOrganizationMember } from './docs/api-remove-organization-member.docs';
import { ApiGetMemberPermissions } from './docs/api-get-member-permissions.docs';
import { ApiAssignMemberPermissions } from './docs/api-assign-member-permissions.docs';

@ApiTags('Organizations')
@ApiBearerAuth('access-token')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly createOrganization: CreateOrganizationUseCase,
    private readonly inviteOrganizationMember: InviteOrganizationMemberUseCase,
    private readonly getOrganizationMemberList: GetOrganizationMemberListUseCase,
    private readonly updateAccountMember: UpdateAccountMemberUseCase,
    private readonly revokeAccountAccess: RevokeAccountAccessUseCase,
    private readonly getMemberPermissions: GetMemberPermissionsUseCase,
    private readonly assignPermissionsToMember: AssignMemberPermissionsUseCase,
  ) {}

  @Post()
  @ApiCreateOrganization()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganizationDto) {
    return this.createOrganization.execute(user.sub, dto);
  }

  @Post('invite')
  @ApiInviteOrganizationMember()
  invite(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.inviteOrganizationMember.execute(user.sub, accountId, dto);
  }

  @Get(':organizationId/members')
  @ApiGetOrganizationMemberList()
  findMembers(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.getOrganizationMemberList.execute(user.sub, organizationId);
  }

  @Patch('members/:accountId/role')
  @ApiUpdateOrganizationMemberRole()
  updateMemberRole(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.updateAccountMember.execute(user.sub, accountId, {
      roleId: dto.roleId,
    });
  }

  @Delete('members/:accountId')
  @ApiRemoveOrganizationMember()
  removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.revokeAccountAccess.execute(user.sub, accountId);
  }

  @Get('members/:accountId/permissions')
  @ApiGetMemberPermissions()
  findMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.getMemberPermissions.execute(user.sub, accountId);
  }

  @Patch('members/:accountId/permissions')
  @ApiAssignMemberPermissions()
  assignMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: AssignMemberPermissionsDto,
  ) {
    return this.assignPermissionsToMember.execute(
      user.sub,
      accountId,
      dto.permissionIds,
    );
  }
}
