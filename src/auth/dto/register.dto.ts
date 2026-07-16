import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
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
    example: 'Gerente de TI',
    description: 'Cargo o puesto del usuario',
  })
  @IsString()
  @IsNotEmpty()
  position: string;

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
}
