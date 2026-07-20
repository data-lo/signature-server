import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Vocabulario del payload en inglés (pedido por la historia), distinto de los enums internos
 * del dominio (`SIGNATURE_TYPE_ENUM`/`COLABORATOR_TYPE_ENUM`, en español/minúsculas) — el
 * mapeo entre ambos vive en `DocumentSignaturesService`.
 */
export enum PAYLOAD_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
}

export enum PAYLOAD_COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  REVIEWER = 'REVIEWER',
}

export class DocumentDataDto {
  @ApiProperty({
    description:
      'Object key del archivo ya subido a MinIO (bucket de documentos creados) — este endpoint no recibe el archivo, solo su referencia.',
    example: '3f9a1e2b-....pdf',
  })
  @IsString()
  @IsNotEmpty()
  objectKey: string;

  @ApiProperty({ example: 'Contrato_2026.pdf' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  fileType: string;

  @ApiPropertyOptional({
    example: 0,
    description: 'Default 0 si se omite.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  visibilityLevel?: number;
}

export class CollaboratorPayloadDto {
  @ApiProperty({ example: 'firmante@empresa.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: PAYLOAD_COLABORATOR_TYPE_ENUM })
  @IsEnum(PAYLOAD_COLABORATOR_TYPE_ENUM)
  colaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM;

  @ApiPropertyOptional({
    enum: PAYLOAD_SIGNATURE_TYPE_ENUM,
    description:
      'Si se omite, hereda el signatureType a nivel documento (ver CreateDocumentSignaturesDto.signatureType).',
  })
  @IsOptional()
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM)
  signatureType?: PAYLOAD_SIGNATURE_TYPE_ENUM;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  signingOrder?: number;

  /**
   * Obligatorio si el signatureType efectivo (propio o heredado del documento) es ADVANCED —
   * se valida en el service, no aquí, porque depende del default a nivel documento (fuera del
   * alcance de este objeto individual para class-validator).
   */
  @ApiPropertyOptional({ example: 'PEGJ850101ABC' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rfc?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Flag explícito de UI para exigir código de verificación (2FA) además del gateo automático por firma ADVANCED.',
  })
  @IsOptional()
  @IsBoolean()
  requiresVerification?: boolean;
}

export class ViewerPayloadDto {
  @ApiProperty({ example: 'observador@empresa.com' })
  @IsEmail()
  email: string;
}

export class CreateDocumentSignaturesDto {
  @ApiProperty({ type: DocumentDataDto })
  @ValidateNested()
  @Type(() => DocumentDataDto)
  documentData: DocumentDataDto;

  @ApiProperty({ type: [CollaboratorPayloadDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CollaboratorPayloadDto)
  collaborators: CollaboratorPayloadDto[];

  @ApiPropertyOptional({ type: [ViewerPayloadDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ViewerPayloadDto)
  viewers?: ViewerPayloadDto[];

  @ApiPropertyOptional({
    enum: PAYLOAD_SIGNATURE_TYPE_ENUM,
    description:
      'Tipo de firma por defecto del documento — cada colaborador puede sobreescribirlo con el suyo propio.',
  })
  @IsOptional()
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM)
  signatureType?: PAYLOAD_SIGNATURE_TYPE_ENUM;
}
