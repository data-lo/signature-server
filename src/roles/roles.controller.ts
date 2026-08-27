import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GetSystemRolesUseCase } from './applications/get-system-roles.use-case';
import { ApiGetSystemRoles } from './docs/api-get-system-roles.docs';

@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('api/v1/roles')
export class RolesController {
  constructor(private readonly getSystemRoles: GetSystemRolesUseCase) {}

  @Get()
  @ApiGetSystemRoles()
  findAllSystemRoles() {
    return this.getSystemRoles.execute();
  }
}
