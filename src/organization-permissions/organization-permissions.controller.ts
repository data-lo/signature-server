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

import { CreateOrganizationPermissionDto } from './dto/create-organization-permission.dto';
import { UpdateOrganizationPermissionDto } from './dto/update-organization-permission.dto';

// Use cases
import { GetOrganizationPermissionsUseCase } from './applications/get-organization-permissions.use-case';
import { CreateOrganizationPermissionUseCase } from './applications/create-organization-permission.use-case';
import { UpdateOrganizationPermissionUseCase } from './applications/update-organization-permission.use-case';
import { DeleteOrganizationPermissionUseCase } from './applications/delete-organization-permission.use-case';

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
    private readonly getOrganizationPermissions: GetOrganizationPermissionsUseCase,
    private readonly createOrganizationPermission: CreateOrganizationPermissionUseCase,
    private readonly updateOrganizationPermission: UpdateOrganizationPermissionUseCase,
    private readonly deleteOrganizationPermission: DeleteOrganizationPermissionUseCase,
  ) {}

  @Get()
  @ApiGetOrganizationPermissions()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.getOrganizationPermissions.execute(user.sub, organizationId);
  }

  @Post()
  @ApiCreateOrganizationPermission()
  create(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateOrganizationPermissionDto,
  ) {
    return this.createOrganizationPermission.execute(
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
    return this.updateOrganizationPermission.execute(
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
    return this.deleteOrganizationPermission.execute(
      user.sub,
      organizationId,
      permissionId,
    );
  }
}
