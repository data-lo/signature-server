import { IsOptional, IsString } from 'class-validator';

export class CreateVerificationCodeDto {
  @IsString()
  signerId: string;

  @IsString()
  documentId: string;

  @IsString()
  @IsOptional()
  type?: string;
}
