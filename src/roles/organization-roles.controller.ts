import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';

import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';

import { CreateOrganizationRoleDto } from './dto/create-organization-role.dto';
import { UpdateOrganizationRoleDto } from './dto/update-organization-role.dto';

import { ListOrganizationRolesUseCase } from './applications/list-organization-roles.use-case';
import { CreateOrganizationRoleUseCase } from './applications/create-organization-role.use-case';
import { UpdateOrganizationRoleUseCase } from './applications/update-organization-role.use-case';

import { ApiListOrganizationRoles } from './docs/api-list-organization-roles.docs';
import { ApiCreateOrganizationRole } from './docs/api-create-organization-role.docs';
import { ApiUpdateOrganizationRole } from './docs/api-update-organization-role.docs';

/**
 * Roles propios de una organización (historia "Reemplazar 'Permisos' por 'Roles y permisos' en
 * organizaciones"), distinto del catálogo de sistema en `RolesController` (`GET /roles`).
 *
 * Sin `DELETE`: no está en el alcance de la historia.
 */
@ApiTags('Organization Roles')
@ApiBearerAuth('access-token')
@Controller('organizations/:organizationId/roles')
export class OrganizationRolesController {
  constructor(
    private readonly listOrganizationRoles: ListOrganizationRolesUseCase,
    private readonly createOrganizationRole: CreateOrganizationRoleUseCase,
    private readonly updateOrganizationRole: UpdateOrganizationRoleUseCase,
  ) {}

  @Get()
  @ApiListOrganizationRoles()
  @RequirePermission(RESOURCE_KEY_ENUM.ROLE, ACTION_KEY_ENUM.READ)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.listOrganizationRoles.execute(user.sub, organizationId);
  }

  @Post()
  @ApiCreateOrganizationRole()
  @RequirePermission(RESOURCE_KEY_ENUM.ROLE, ACTION_KEY_ENUM.MANAGE)
  create(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateOrganizationRoleDto,
  ) {
    return this.createOrganizationRole.execute(user.sub, organizationId, dto);
  }

  @Patch(':roleId')
  @ApiUpdateOrganizationRole()
  @RequirePermission(RESOURCE_KEY_ENUM.ROLE, ACTION_KEY_ENUM.MANAGE)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateOrganizationRoleDto,
  ) {
    return this.updateOrganizationRole.execute(
      user.sub,
      organizationId,
      roleId,
      dto,
    );
  }
}
