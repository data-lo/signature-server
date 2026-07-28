import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import { Match } from '../validators/match.decorator';

export class RegisterDto {
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
    example: 'PELJ850101HDFRNN08',
    description: 'CURP del usuario (18 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(18, 18)
  nationalId: string;

  @ApiProperty({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario (12 o 13 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(12, 13)
  rfc: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Contraseña (mínimo 8 caracteres)',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Confirmación de la contraseña',
  })
  @IsString()
  @Match('password', { message: 'Las contraseñas no coinciden' })
  confirmPassword: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'Token de invitación a organización (ver /join) — si viene presente, el registro une automáticamente al usuario recién creado a esa organización',
    required: false,
  })
  @IsOptional()
  @IsString()
  invitationToken?: string;
}
