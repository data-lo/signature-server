// dto/get-documents-query.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsUUID,
  IsEmail,
  IsEnum,
  IsDateString,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsString,
} from 'class-validator';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

export class GetDocumentsQueryDto {
  @ApiPropertyOptional({ description: 'UUID del documento', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Email de un participante (firmante o espectador) del documento',
  })
  @IsOptional()
  @IsEmail()
  participantEmail?: string;

  @ApiPropertyOptional({
    description:
      'Email del propietario o de cualquier participante del documento',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_STATUS_ENUM })
  @IsOptional()
  @IsEnum(DOCUMENT_STATUS_ENUM)
  status?: DOCUMENT_STATUS_ENUM;

  @ApiPropertyOptional({
    description: 'Incluir URL segura del documento en la respuesta',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  withUrl?: boolean = false;

  @ApiPropertyOptional({
    description: 'Fecha de creación inicio (ISO 8601)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'Fecha de creación fin (ISO 8601)',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Fecha de firma inicio (ISO 8601)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  signedDateFrom?: string;

  @ApiPropertyOptional({
    description: 'Fecha de firma fin (ISO 8601)',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  signedDateTo?: string;

  @ApiPropertyOptional({
    description: 'Búsqueda parcial por nombre de archivo',
  })
  @IsOptional()
  @IsString()
  fileName?: string;

  @ApiPropertyOptional({
    description:
      'Búsqueda parcial por nombre o correo de un firmante/espectador',
  })
  @IsOptional()
  @IsString()
  participantName?: string;

  @ApiPropertyOptional({
    description:
      'Requiere participantEmail. Solo documentos donde ese participante es firmante y le toca firmar en este momento',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  myTurnOnly?: boolean = false;

  @ApiPropertyOptional({ description: 'Página', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Resultados por página',
    default: 10,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}
