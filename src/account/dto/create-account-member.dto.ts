import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateAccountMemberDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la organización a la que se otorga acceso',
    format: 'uuid',
  })
  @IsUUID()
  organizationId: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario que recibe el acceso',
    format: 'uuid',
  })
  @IsUUID()
  userId: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del rol asignado en esa cuenta (ver GET /api/v1/roles)',
    format: 'uuid',
  })
  @IsUUID()
  roleId: string;

  @ApiProperty({
    example: 'Gerente de TI',
    description:
      'Puesto o cargo oficial del usuario, aplica si la cuenta es de tipo ORGANIZATION',
    required: false,
  })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiProperty({
    example: true,
    description: 'Define si el acceso del usuario a este entorno está vigente',
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
