import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import { UserRoles } from '../interfaces/user.roles.enum';

export class CreateUserDto {
  @ApiProperty({ example: 'Juan', description: 'Nombre(s) del usuario' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Pérez López', description: 'Apellidos del usuario' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ example: 'juan.perez@empresa.com', description: 'Correo electrónico único del usuario' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: 'Gerente de TI', description: 'Cargo o puesto del usuario' })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma asociada al usuario', format: 'uuid' })
  @IsString()
  @IsOptional()
  signatureId: string;

  @ApiProperty({ example: true, description: 'Indica si el usuario está activo en el sistema' })
  @IsBoolean()
  @IsOptional()
  isActive: boolean;

  @ApiProperty({ example: ['admin', 'signer'], description: 'Lista de roles asignados al usuario', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsEnum(UserRoles, { each: true })
  @IsOptional()
  rol: string[];

  @ApiProperty({ example: 'PELJ850101HDFRNN08', description: 'CURP del usuario (18 caracteres)' })
  @IsString()
  @IsNotEmpty()
  curp: string;
}
