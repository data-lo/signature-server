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

// Service
import { AccountService } from './account.service';
import { AccountMemberService } from './account-member.service';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationPermissionsService } from 'src/organization-permissions/organization-permissions.service';

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
    private readonly accountService: AccountService,
    private readonly accountMemberService: AccountMemberService,
    private readonly organizationInvitationService: OrganizationInvitationService,
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  @Post()
  @ApiCreateOrganization()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganizationDto) {
    return this.accountService.createOrganization(user.sub, dto);
  }

  @Post('invite')
  @ApiInviteOrganizationMember()
  async invite(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: InviteMemberDto,
  ) {
    const { data } = await this.accountService.inviteMember(
      user.sub,
      accountId,
      dto,
    );

    await this.organizationInvitationService.create({
      organizationId: data.organizationId,
      roleId: dto.roleId,
      invitedBy: user.sub,
      email: dto.email,
    });

    return {
      success: true,
      message: 'Invitación enviada correctamente',
      data: null,
    };
  }

  @Get(':organizationId/members')
  @ApiGetOrganizationMemberList()
  findMembers(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.accountMemberService.findMembersForOrganizationDetailed(
      user.sub,
      organizationId,
    );
  }

  @Patch('members/:accountId/role')
  @ApiUpdateOrganizationMemberRole()
  updateMemberRole(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.accountMemberService.update(user.sub, accountId, {
      roleId: dto.roleId,
    });
  }

  @Delete('members/:accountId')
  @ApiRemoveOrganizationMember()
  removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.accountMemberService.remove(user.sub, accountId);
  }

  @Get('members/:accountId/permissions')
  @ApiGetMemberPermissions()
  findMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.organizationPermissionsService.findMemberPermissions(
      user.sub,
      accountId,
    );
  }

  @Patch('members/:accountId/permissions')
  @ApiAssignMemberPermissions()
  assignMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: AssignMemberPermissionsDto,
  ) {
    return this.organizationPermissionsService.assignToMember(
      user.sub,
      accountId,
      dto.permissionIds,
    );
  }
}
