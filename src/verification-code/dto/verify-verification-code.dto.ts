import { IsString } from 'class-validator';

export class VerifyVerificationCodeDto {
  @IsString()
  signerId: string;

  @IsString()
  token: string;
}
