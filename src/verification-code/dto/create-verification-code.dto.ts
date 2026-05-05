import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVerificationCodeDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Signer ID who will receive the OTP code',
    format: 'uuid',
  })
  @IsString()
  signerId: string;

  @ApiProperty({
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    description: 'Document ID that requires verification',
    format: 'uuid',
  })
  @IsString()
  documentId: string;

  @ApiPropertyOptional({
    example: 'document_signing',
    description: 'Verification type. Defaults to document_signing',
  })
  @IsString()
  @IsOptional()
  type?: string;
}