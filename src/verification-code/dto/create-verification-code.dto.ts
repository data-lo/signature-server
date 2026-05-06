import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateVerificationCodeDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante del documento', format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  signerId: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del documento a firmar', format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  documentId: string;

  @ApiProperty({ example: 'email', description: 'Canal de envío del código OTP', enum: ['email', 'sms'] })
  @IsString()
  @IsNotEmpty()
  type: string;
}
