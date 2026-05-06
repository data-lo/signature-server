import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumberString, Length } from 'class-validator';
import { CreateVerificationCodeDto } from './create-verification-code.dto';

export class validateCodeDto extends CreateVerificationCodeDto {
  @ApiProperty({ example: '123456', description: 'Código OTP de 6 dígitos enviado al firmante' })
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}
