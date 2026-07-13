import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class UpdatePersonalInformationDto {
  @ApiPropertyOptional({ example: 'Juan', description: 'Nombre(s)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'Pérez López', description: 'Apellidos' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @ApiPropertyOptional({
    example: 'PELJ850101HDFRNN08',
    description: 'CURP (18 caracteres alfanuméricos)',
  })
  @IsOptional()
  @IsString()
  @Length(18, 18)
  curp?: string;

  @ApiPropertyOptional({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario',
  })
  @IsOptional()
  @IsString()
  rfc?: string;

  @ApiPropertyOptional({
    example: '5512345678',
    description: 'Número de teléfono de contacto',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'juan.perez@personal.com',
    description: 'Correo electrónico secundario',
  })
  @IsOptional()
  @IsEmail()
  secondaryEmail?: string;
}
