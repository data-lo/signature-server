import { PartialType } from '@nestjs/swagger';
import { CreateOrganizationRoleDto } from './create-organization-role.dto';

export class UpdateOrganizationRoleDto extends PartialType(
  CreateOrganizationRoleDto,
) {}
