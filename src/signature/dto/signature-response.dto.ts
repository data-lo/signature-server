import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseDto } from '../../interfaces/api-response.dto';

export class SignatureDataDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma', format: 'uuid' })
  id: string;
}

export class SignatureResponseDto extends ApiResponseDto {
  @ApiProperty({ type: SignatureDataDto, description: 'Datos de la firma' })
  data: SignatureDataDto;
}
