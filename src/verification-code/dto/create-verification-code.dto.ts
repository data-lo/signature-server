import { IsString } from 'class-validator';

export class CreateVerificationCodeDto {
  @IsString()
  signerId: string;

  @IsString()
  documentId: string;

  @IsString()
  type: string;
}