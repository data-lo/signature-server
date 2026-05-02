import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateVerificationCodeDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante al que se enviará el código OTP', format: 'uuid' })
  @IsString()
  signerId: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del documento que requiere verificación', format: 'uuid' })
  @IsString()
  documentId: string;

  @ApiPropertyOptional({ example: 'document_signing', description: 'Tipo de verificación. Por defecto: document_signing' })
  @IsString()
  @IsOptional()
  type?: string;
}
