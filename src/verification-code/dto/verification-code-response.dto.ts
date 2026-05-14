import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../interfaces/api-response.dto';

export class VerificationCodeDataDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del código de verificación generado', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'email', description: 'Canal de envío del código OTP' })
  type: string;

  @ApiProperty({ example: '2024-01-15T10:35:00Z', description: 'Fecha y hora de expiración del código OTP' })
  expiredAt: Date;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del documento relacionado', format: 'uuid' })
  documentId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante', format: 'uuid' })
  signerId: string;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de creación del registro' })
  createdAt: Date;
}

export class VerificationCodeResponseDto extends BaseResponse {
  @ApiProperty({ type: VerificationCodeDataDto, description: 'Datos del código de verificación generado' })
  data: VerificationCodeDataDto;
}
