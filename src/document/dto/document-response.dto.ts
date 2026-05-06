import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class DocumentResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del documento', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'contrato.pdf', description: 'Nombre original del archivo PDF' })
  fileName: string;

  @ApiProperty({ example: 'application/pdf', description: 'Tipo MIME del archivo' })
  fileType: string;

  @ApiProperty({ example: 5, description: 'Número total de páginas del documento' })
  totalPages: number;

  @ApiProperty({ example: DOCUMENT_STATUS_ENUM.CREATED, description: 'Estado actual del documento', enum: DOCUMENT_STATUS_ENUM })
  status: DOCUMENT_STATUS_ENUM;

  @ApiPropertyOptional({ example: '2024-01-15T10:30:00Z', description: 'Fecha y hora en que fue firmado el documento', nullable: true })
  signedAt: Date | null;

  @ApiProperty({ type: SignatureCoordinatesResponseDto, description: 'Coordenadas donde se colocará la firma en el PDF' })
  signatureCoordinates: SignatureCoordinatesResponseDto;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante del documento', format: 'uuid' })
  signerId: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del usuario que solicitó la firma', format: 'uuid' })
  createdBy: string;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de creación del registro' })
  createdAt: Date;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de última actualización' })
  updatedAt: Date;
}
