import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseDto } from '../../interfaces/api-response.dto';

export class DocumentDataDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', description: 'UUID del documento' })
  id: string;

  @ApiPropertyOptional({ example: 'http://example.com/document.pdf', description: 'URL del archivo PDF (disponible tras procesar)' })
  documentUrl: string | null;

  @ApiProperty({ example: '2026-01-15T10:30:00.000Z', description: 'Fecha de creación del documento' })
  createdAt: Date;
}

export class DocumentResponseDto extends ApiResponseDto {
  @ApiProperty({ type: DocumentDataDto, description: 'Datos de la respuesta' })
  data: DocumentDataDto;
}
