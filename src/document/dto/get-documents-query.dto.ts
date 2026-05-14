// dto/get-documents-query.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsOptional, IsUUID, IsEmail, IsEnum, IsDateString, IsInt, Min, Max, IsBoolean, IsString } from 'class-validator';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

export class GetDocumentsQueryDto {
  @ApiPropertyOptional({ description: 'UUID del documento', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ description: 'UUID del firmante', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  signerId?: string;

  @ApiPropertyOptional({ description: 'Email del firmante o propietario' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_STATUS_ENUM })
  @IsOptional()
  @IsEnum(DOCUMENT_STATUS_ENUM)
  status?: DOCUMENT_STATUS_ENUM;

  @ApiPropertyOptional({ description: 'Incluir URL segura del documento en la respuesta', default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  withUrl?: boolean = false;

  @ApiPropertyOptional({ description: 'Fecha inicio (ISO 8601)', example: '2024-01-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Fecha fin (ISO 8601)', example: '2024-12-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Página', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Resultados por página', default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}