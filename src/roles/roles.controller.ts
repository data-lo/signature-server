import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { ApiGetSystemRoles } from './docs/api-get-system-roles.docs';

@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('api/v1/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiGetSystemRoles()
  findAllSystemRoles() {
    return this.rolesService.findAllSystemRoles();
  }
}
