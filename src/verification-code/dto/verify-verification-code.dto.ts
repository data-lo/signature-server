import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class VerifyVerificationCodeDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante que ingresa el código', format: 'uuid' })
  @IsString()
  signerId: string;

  @ApiProperty({ example: '482910', description: 'Código OTP de 6 dígitos recibido por correo' })
  @IsString()
  token: string;
}
