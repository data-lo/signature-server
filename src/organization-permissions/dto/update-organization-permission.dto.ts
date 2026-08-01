import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateOrganizationPermissionDto } from './create-organization-permission.dto';

export class UpdateOrganizationPermissionDto extends PartialType(
  CreateOrganizationPermissionDto,
) {
  @ApiPropertyOptional({
    example: false,
    description: 'Activa o desactiva el permiso sin eliminarlo del catálogo',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
