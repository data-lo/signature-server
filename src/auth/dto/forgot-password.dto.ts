import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico de la cuenta a recuperar',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
