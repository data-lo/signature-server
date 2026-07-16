import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ACCOUNT_MEMBER_ROLE_ENUM } from '../enums/account-member-role.enum';

export class CreateAccountMemberDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la cuenta a la que se otorga acceso',
    format: 'uuid',
  })
  @IsUUID()
  accountId: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario que recibe el acceso',
    format: 'uuid',
  })
  @IsUUID()
  userId: string;

  @ApiProperty({
    example: [ACCOUNT_MEMBER_ROLE_ENUM.OWNER],
    description: 'Lista de roles asignados en esa cuenta',
    enum: ACCOUNT_MEMBER_ROLE_ENUM,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ACCOUNT_MEMBER_ROLE_ENUM, { each: true })
  role: ACCOUNT_MEMBER_ROLE_ENUM[];

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
