import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { UserRoles } from '../enums/user-roles';

export class CreateUserDto {
  @ApiProperty({ example: 'Juan', description: 'Nombre(s) del usuario' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Pérez López', description: 'Apellidos del usuario' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico único del usuario',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: ['signer'],
    description: 'Lista de roles asignados al usuario',
    type: [String],
    enum: UserRoles,
  })
  @IsArray()
  @IsString({ each: true })
  @IsEnum(UserRoles, { each: true })
  roles: string[];

  @ApiProperty({
    example: 'PELJ850101HDFRNN08',
    description: 'CURP del usuario (18 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(18, 18)
  nationalId: string;

  @ApiPropertyOptional({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario (12 o 13 caracteres alfanuméricos)',
  })
  @IsOptional()
  @IsString()
  @Length(12, 13)
  rfc?: string;
}
