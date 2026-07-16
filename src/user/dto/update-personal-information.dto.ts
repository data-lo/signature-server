import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

// name, lastName, curp y rfc son campos de identidad: no son editables por este endpoint.
export class UpdatePersonalInformationDto {
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
