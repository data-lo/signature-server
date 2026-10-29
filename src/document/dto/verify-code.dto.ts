import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyCodeDto {
  @ApiProperty({
    example: '482913',
    description: 'Código de verificación recibido por correo',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}
