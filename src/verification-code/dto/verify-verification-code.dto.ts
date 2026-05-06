import { CreateVerificationCodeDto } from './create-verification-code.dto';

export class validateCodeDto extends CreateVerificationCodeDto {
  ipAddress: string;
  code: string
}
