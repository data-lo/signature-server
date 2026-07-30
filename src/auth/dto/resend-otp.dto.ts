import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ResendOtpDto {
  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico asociado al pre-registro',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
