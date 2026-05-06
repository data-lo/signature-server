import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocumentStatus } from '../lib/document-status';

export class DocumentCoordDto {
  @ApiProperty({ example: 50, description: 'Coordenada izquierda de la firma en el documento (px)' })
  @IsNumber()
  left: number;

  @ApiProperty({ example: 250, description: 'Coordenada derecha de la firma en el documento (px)' })
  @IsNumber()
  right: number;

  @ApiProperty({ example: 700, description: 'Coordenada superior de la firma en el documento (px)' })
  @IsNumber()
  top: number;

  @ApiProperty({ example: 780, description: 'Coordenada inferior de la firma en el documento (px)' })
  @IsNumber()
  bottom: number;
}

export class CreateDocumentDto {
  @ApiProperty({ example: 'documents-bucket', description: 'ID del bucket en Minio donde se almacena el documento' })
  @IsString()
  @IsNotEmpty()
  bucketId: string;

  @ApiProperty({ example: 'contrato_2024.pdf', description: 'Nombre del archivo del documento' })
  @IsString()
  @IsNotEmpty()
  file_name: string;

  @ApiProperty({ example: 'https://storage.example.com/doc.pdf', description: 'URL pública o interna del documento' })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiProperty({ example: '192.168.1.100', description: 'Dirección IP desde donde se subió el documento' })
  @IsString()
  @IsNotEmpty()
  ip: string;

  @ApiProperty({ example: 'c3d4e5f6-a7b8-9012-cdef-123456789012', description: 'UUID del código OTP usado para autorizar la firma', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  otp_id: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del usuario que sube el documento', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: '2024-06-15T10:30:00.000Z', description: 'Fecha y hora en que se firmó el documento' })
  @Type(() => Date)
  @IsDate()
  signed_at: Date;

  @ApiProperty({ example: 5, description: 'Número total de páginas del documento' })
  @IsNumber()
  total_pages: number;

  @ApiProperty({ example: 'application/pdf', description: 'Tipo MIME del archivo' })
  @IsString()
  @IsNotEmpty()
  file_type: string;

  @ApiProperty({ example: 'sha256:abc123...', description: 'Hash del documento antes de firmar (integridad)' })
  @IsString()
  @IsNotEmpty()
  hashing_before: string;

  @ApiProperty({ example: 'sha256:def456...', description: 'Hash del documento después de firmar (integridad)' })
  @IsString()
  @IsNotEmpty()
  hashing_after: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del usuario que solicita la firma', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  request_signer_id: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del firmante del documento', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  signer: string;

  @ApiProperty({ enum: DocumentStatus, example: DocumentStatus.PENDING, description: 'Estado actual del documento' })
  @IsEnum(DocumentStatus)
  status: DocumentStatus;

  @ApiProperty({ example: false, description: 'Indica si se notificó al firmante sobre el documento' })
  @IsBoolean()
  is_notified: boolean;

  @ApiProperty({ type: DocumentCoordDto, description: 'Coordenadas donde se colocará la firma en el documento' })
  @ValidateNested()
  @Type(() => DocumentCoordDto)
  coord: DocumentCoordDto;
}
