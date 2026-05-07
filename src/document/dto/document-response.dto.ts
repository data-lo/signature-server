import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseDto } from '../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

export class SignatureCoordinatesResponseDto {
  @ApiProperty({ example: 50, description: 'Coordenada izquierda de la firma en el documento (px)' })
  left: number;

  @ApiProperty({ example: 250, description: 'Coordenada derecha de la firma en el documento (px)' })
  right: number;

  @ApiProperty({ example: 700, description: 'Coordenada superior de la firma en el documento (px)' })
  top: number;

  @ApiProperty({ example: 780, description: 'Coordenada inferior de la firma en el documento (px)' })
  bottom: number;
}

export class DocumentDataDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', description: 'UUID del documento', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'contrato.pdf', description: 'Nombre original del archivo' })
  fileName: string;

  @ApiProperty({ example: 'application/pdf', description: 'Tipo MIME del archivo' })
  fileType: string;

  @ApiProperty({ example: 5, description: 'Número total de páginas del documento' })
  totalPages: number;

  @ApiPropertyOptional({ example: 'http://example.com/document.pdf', description: 'URL del archivo PDF (disponible tras procesar)', nullable: true })
  documentUrl: string | null;

  @ApiProperty({ enum: DOCUMENT_STATUS_ENUM, example: DOCUMENT_STATUS_ENUM.CREATED, description: 'Estado actual del documento' })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({ type: SignatureCoordinatesResponseDto, description: 'Coordenadas del área de firma en el documento' })
  signatureCoordinates: SignatureCoordinatesResponseDto;

  @ApiProperty({ example: '2026-01-15T10:30:00.000Z', description: 'Fecha de creación del documento' })
  createdAt: Date;

  @ApiPropertyOptional({ example: '2026-01-16T08:00:00.000Z', description: 'Fecha en que fue firmado el documento', nullable: true })
  signedAt: Date | null;
}

export class DocumentResponseDto extends ApiResponseDto {
  @ApiProperty({ type: DocumentDataDto, description: 'Datos del documento' })
  data: DocumentDataDto;
}
