import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

import { OrganizationPermissionsService } from './organization-permissions.service';
import { CreateOrganizationPermissionDto } from './dto/create-organization-permission.dto';
import { UpdateOrganizationPermissionDto } from './dto/update-organization-permission.dto';

// Docs
import { ApiGetOrganizationPermissions } from './docs/api-get-organization-permissions.docs';
import { ApiCreateOrganizationPermission } from './docs/api-create-organization-permission.docs';
import { ApiUpdateOrganizationPermission } from './docs/api-update-organization-permission.docs';
import { ApiDeleteOrganizationPermission } from './docs/api-delete-organization-permission.docs';

@ApiTags('Organization Permissions')
@ApiBearerAuth('access-token')
@Controller('api/v1/organizations/:organizationId/permissions')
export class OrganizationPermissionsController {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  @Get()
  @ApiGetOrganizationPermissions()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizationPermissionsService.findAllForOrganization(
      user.sub,
      organizationId,
    );
  }

  @Post()
  @ApiCreateOrganizationPermission()
  create(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateOrganizationPermissionDto,
  ) {
    return this.organizationPermissionsService.create(
      user.sub,
      organizationId,
      dto,
    );
  }

  @Patch(':permissionId')
  @ApiUpdateOrganizationPermission()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Param('permissionId') permissionId: string,
    @Body() dto: UpdateOrganizationPermissionDto,
  ) {
    return this.organizationPermissionsService.update(
      user.sub,
      organizationId,
      permissionId,
      dto,
    );
  }

  @Delete(':permissionId')
  @ApiDeleteOrganizationPermission()
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Param('permissionId') permissionId: string,
  ) {
    return this.organizationPermissionsService.remove(
      user.sub,
      organizationId,
      permissionId,
    );
  }
}
