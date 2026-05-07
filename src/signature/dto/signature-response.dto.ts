import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseDto } from '../../interfaces/api-response.dto';

export class SignatureDataDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma', format: 'uuid' })
  id: string;

  @ApiProperty({ example: true, description: 'Indica si la firma está activa' })
  isActive: boolean;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del usuario propietario de la firma', format: 'uuid' })
  userId: string;

  @ApiPropertyOptional({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del usuario que registró la firma', format: 'uuid', nullable: true })
  createdBy: string | null;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de creación del registro' })
  createdAt: Date;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de última actualización' })
  updatedAt: Date;
}

export class SignatureResponseDto extends ApiResponseDto {
  @ApiProperty({ type: SignatureDataDto, description: 'Datos de la firma' })
  data: SignatureDataDto;
}
