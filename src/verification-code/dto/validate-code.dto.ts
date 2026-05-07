import { IsString } from 'class-validator';
import { CreateVerificationCodeDto } from './create-verification-code.dto';

export class ValidateCodeDto extends CreateVerificationCodeDto {
  @IsString()
  code: string;
}