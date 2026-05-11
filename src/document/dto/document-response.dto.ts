import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseDto } from '../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

export class DocumentDataDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', description: 'UUID del documento' })
  id: string;

  @ApiPropertyOptional({ example: 'http://example.com/document.pdf', description: 'URL del archivo PDF (disponible tras procesar)' })
  documentUrl: string | null;

  @ApiProperty({ example: '2026-01-15T10:30:00.000Z', description: 'Fecha de creación del documento' })
  createdAt: Date;
}

export class SignerDocumentDataDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', description: 'UUID del documento', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'contrato_servicio.pdf', description: 'Nombre original del archivo' })
  fileName: string;

  @ApiProperty({ example: 'application/pdf', description: 'Tipo MIME del archivo' })
  fileType: string;

  @ApiProperty({ enum: DOCUMENT_STATUS_ENUM, example: DOCUMENT_STATUS_ENUM.PENDING, description: 'Estatus actual del documento' })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante asignado', format: 'uuid' })
  signerId: string;

  @ApiPropertyOptional({ example: '2026-02-01T14:00:00.000Z', description: 'Fecha en que se firmó el documento', nullable: true })
  signedAt: Date | null;

  @ApiProperty({ example: '2026-01-15T10:30:00.000Z', description: 'Fecha de creación del documento' })
  createdAt: Date;
}

export class DocumentResponseDto extends ApiResponseDto {
  @ApiProperty({ type: DocumentDataDto, description: 'Datos de la respuesta' })
  data: DocumentDataDto;
}

export class SignerDocumentListResponseDto extends ApiResponseDto {
  @ApiProperty({ type: [SignerDocumentDataDto], description: 'Lista de documentos del firmante' })
  data: SignerDocumentDataDto[];
}
